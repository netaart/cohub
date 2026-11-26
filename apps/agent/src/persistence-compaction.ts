import { resolveWalletMessageEligibility } from "@cohub/core/space-wallet";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Usage } from "@cohub/protocol/core";
import type {
  ContextCompactionMeta,
  ContextCompactionScope,
  ContextCompactionTriggerReason,
  PersistMessageInput,
} from "@cohub/protocol/model";
import { sessionMessages, sessionTurns } from "@cohub/db";
import { scheduleSessionSnapshot } from "./session-snapshot.js";
import { enqueueSessionMessagePostprocess } from "./session-message-postprocess-queue.js";
import { indexTurnReferences } from "./reference-index.js";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { publishRealtimeEnvelope } from "./redis.js";
import { normalizeUsage, toMessageRecord, toTurnRecord } from "./persistence-records.js";
import { addUsage, buildIntermediateObjectsForTurn } from "./persistence-intermediates.js";
import { publishMessagePersisted, publishTurnCreated, publishTurnFinalized } from "./persistence-events.js";

type PersistCompactionEventInput = {
  spaceId: string;
  sessionId: string;
  actorUserId: string | null;
  compactionId: string;
  scope: ContextCompactionScope;
  ownerTurnId: string | null;
  firstKeptTurnId: string | null;
  llmRound: number | null;
  triggerReason: ContextCompactionTriggerReason;
  summary: string;
  tokensBefore: number;
  estimatedTokensAfter: number | null;
  firstKeptEntryId: string;
  model: { provider: string; id: string };
  contextWindow: number;
  keepRecentTokens: number;
  summarizedMessageCount: number;
  attemptCount: number;
  providerCalls: {
    total: number;
    succeeded: number;
    failed: number;
  };
  isSplitTurn: boolean;
  usage: Usage | null | undefined;
  durationMs: number;
  archivePath: string | undefined;
  insertBeforeTurnSequence: number | null;
};

/** Persist a turn-boundary or in-turn compaction event at its retained-tail boundary. */
export async function persistCompactionEvent(
  input: PersistCompactionEventInput,
): Promise<{ compactTurnId: string | null; compactSequence: number | null; messageSequence: number } | null> {
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - Math.max(0, input.durationMs));
  const usage = normalizeUsage(input.usage as PersistMessageInput["message"]["usage"]);
  const state: {
    turnRow: typeof sessionTurns.$inferSelect | null;
    ownerTurnRow: typeof sessionTurns.$inferSelect | null;
    messageRow: typeof sessionMessages.$inferSelect | null;
    compactSequence: number | null;
    messageSequence: number;
  } = {
    turnRow: null,
    ownerTurnRow: null,
    messageRow: null,
    compactSequence: null,
    messageSequence: 0,
  };

  try {
    await db.transaction(async (tx) => {
      const anchorTurnId = input.firstKeptTurnId ?? input.ownerTurnId;
      const [anchorByEntry] = await tx.select({ id: sessionMessages.id, sequence: sessionMessages.sequence })
        .from(sessionMessages)
        .where(and(
          eq(sessionMessages.sessionId, input.sessionId),
          anchorTurnId ? eq(sessionMessages.turnId, anchorTurnId) : undefined,
          sql`${sessionMessages.meta}->>'agentSessionEntryId' = ${input.firstKeptEntryId}`,
        ))
        .limit(1);
      if (input.scope === "within_turn" && !anchorByEntry) {
        throw new Error(`In-turn compaction anchor not found: ${input.firstKeptEntryId}`);
      }
      const [anchorByTurn] = anchorByEntry || !input.firstKeptTurnId
        ? []
        : await tx.select({ id: sessionMessages.id, sequence: sessionMessages.sequence })
          .from(sessionMessages)
          .where(and(
            eq(sessionMessages.sessionId, input.sessionId),
            eq(sessionMessages.turnId, input.firstKeptTurnId),
          ))
          .orderBy(asc(sessionMessages.sequence))
          .limit(1);
      const anchor = anchorByEntry ?? anchorByTurn ?? null;
      const [maxMessage] = anchor
        ? []
        : await tx.select({ max: sql<number>`coalesce(max(${sessionMessages.sequence}), 0)::int` })
          .from(sessionMessages)
          .where(eq(sessionMessages.sessionId, input.sessionId));
      const messageSequence = anchor?.sequence ?? ((maxMessage?.max ?? 0) + 1);

      await tx.update(sessionMessages)
        .set({ sequence: sql`${sessionMessages.sequence} + 1000000` })
        .where(and(eq(sessionMessages.sessionId, input.sessionId), gte(sessionMessages.sequence, messageSequence)));
      await tx.update(sessionMessages)
        .set({ sequence: sql`${sessionMessages.sequence} - 999999` })
        .where(and(eq(sessionMessages.sessionId, input.sessionId), gte(sessionMessages.sequence, messageSequence + 1000000)));

      let compactTurnId: string | null = null;
      let ordinalInTurn: number | null = null;
      if (input.scope === "between_turns") {
        const compactSequence = input.insertBeforeTurnSequence;
        if (compactSequence == null) throw new Error("Missing compact turn insertion sequence");
        await tx.update(sessionTurns)
          .set({ sequence: sql`${sessionTurns.sequence} + 1000000` })
          .where(and(eq(sessionTurns.sessionId, input.sessionId), gte(sessionTurns.sequence, compactSequence)));
        await tx.update(sessionTurns)
          .set({ sequence: sql`${sessionTurns.sequence} - 999999` })
          .where(and(eq(sessionTurns.sessionId, input.sessionId), gte(sessionTurns.sequence, compactSequence + 1000000)));
        state.compactSequence = compactSequence;
      } else {
        if (!input.ownerTurnId) throw new Error("Missing owner turn for in-turn compaction");
        const [ownerTurn] = await tx.select().from(sessionTurns)
          .where(and(eq(sessionTurns.id, input.ownerTurnId), eq(sessionTurns.sessionId, input.sessionId)))
          .limit(1);
        if (!ownerTurn) throw new Error("In-turn compaction owner turn not found");
        state.ownerTurnRow = ownerTurn;
        const [ordinalRow] = await tx.select({
          ordinal: sql<number>`count(*)::int + 1`,
        }).from(sessionMessages).where(and(
          eq(sessionMessages.sessionId, input.sessionId),
          eq(sessionMessages.turnId, input.ownerTurnId),
          sql`${sessionMessages.meta}->>'messageKind' = 'compacted'`,
        ));
        ordinalInTurn = ordinalRow?.ordinal ?? 1;
      }

      const compaction: ContextCompactionMeta = {
        version: 1,
        compactionId: input.compactionId,
        scope: input.scope,
        ownerTurnId: input.ownerTurnId,
        ordinalInTurn,
        llmRound: input.llmRound,
        triggerReason: input.triggerReason,
        contextWindow: input.contextWindow,
        tokensBefore: input.tokensBefore,
        estimatedTokensAfter: input.estimatedTokensAfter,
        provider: input.model.provider,
        model: input.model.id,
        keepRecentTokens: input.keepRecentTokens,
        summarizedMessageCount: input.summarizedMessageCount,
        attemptCount: input.attemptCount,
        providerCalls: input.providerCalls,
        isSplitTurn: input.isSplitTurn,
        firstKeptEntryId: input.firstKeptEntryId,
        archivePath: input.archivePath ?? null,
        compactedAt: completedAt.toISOString(),
        placement: {
          beforeSessionEntryId: input.firstKeptEntryId,
          beforeMessageId: anchor?.id ?? null,
        },
      };
      const compactionMeta = { compaction };

      if (input.scope === "between_turns") {
        const compactSequence = state.compactSequence;
        if (compactSequence == null) throw new Error("Missing compact turn sequence");
        const [turnRow] = await tx.insert(sessionTurns).values({
          sessionId: input.sessionId,
          spaceId: input.spaceId,
          userUuid: input.actorUserId,
          sequence: compactSequence,
          status: "completed",
          intent: "compact",
          userContent: [],
          userText: null,
          assistantContent: [{ type: "system_note", note_type: "compacted", text: input.summary }],
          assistantText: null,
          provider: input.model.provider,
          model: input.model.id,
          stopReason: null,
          errorMessage: null,
          finalUsage: usage,
          totalUsage: usage,
          summary: { finishReason: "completed" },
          meta: compactionMeta,
          startedAt,
          completedAt,
          durationMs: input.durationMs,
        }).returning();
        if (!turnRow) throw new Error("Failed to insert compact turn");
        state.turnRow = turnRow;
        compactTurnId = turnRow.id;
      }

      const messageTurnId = input.scope === "within_turn" ? input.ownerTurnId : compactTurnId;
      const [messageRow] = await tx.insert(sessionMessages).values({
        sessionId: input.sessionId,
        turnId: messageTurnId,
        role: "system",
        content: [{ type: "system_note", note_type: "compacted", text: input.summary }],
        text: null,
        provider: input.model.provider,
        model: input.model.id,
        sequence: messageSequence,
        idempotencyKey: `compaction:${input.compactionId}`,
        usage,
        meta: {
          messageKind: "compacted",
          turnId: messageTurnId,
          actorUserId: input.actorUserId,
          ...compactionMeta,
          walletBillingEligible: resolveWalletMessageEligibility(),
        },
        startedAt,
        completedAt,
        durationMs: input.durationMs,
      }).returning();
      if (!messageRow) throw new Error("Failed to insert compact message");
      state.messageRow = messageRow;
      state.messageSequence = messageSequence;

    });
  } catch (error) {
    logger.error(`[Compaction] DB transaction failed sessionId=${input.sessionId}:`, error);
    return null;
  }

  const ownerTurn = state.ownerTurnRow;
  if (
    ownerTurn &&
    !["queued", "running", "abort_requested", "interrupted"].includes(ownerTurn.status)
  ) {
    try {
      const rebuilt = await buildIntermediateObjectsForTurn({
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        turnId: ownerTurn.id,
      });
      const [rebuiltTurn] = await db.update(sessionTurns)
        .set({
          intermediateIndex: rebuilt.index ?? ownerTurn.intermediateIndex,
          intermediateSummary: rebuilt.summary,
          totalUsage: addUsage(rebuilt.summary.usage, ownerTurn.finalUsage as Usage | null),
          updatedAt: completedAt,
        })
        .where(and(eq(sessionTurns.id, ownerTurn.id), eq(sessionTurns.sessionId, input.sessionId)))
        .returning();
      if (rebuiltTurn) {
        state.ownerTurnRow = rebuiltTurn;
        indexTurnReferences({
          spaceId: input.spaceId,
          sessionId: input.sessionId,
          turnId: ownerTurn.id,
          messages: rebuilt.rows,
        });
      }
    } catch (error) {
      logger.warn("[Compaction] failed to rebuild completed owner turn", error);
    }
  }

  if (state.turnRow) {
    const turn = toTurnRecord(state.turnRow);
    await publishTurnCreated(input.spaceId, turn).catch((error) => {
      logger.warn("[Compaction] failed to publish turn created", error);
    });
    await publishTurnFinalized(input.spaceId, turn).catch((error) => {
      logger.warn("[Compaction] failed to publish turn finalized", error);
    });
  } else if (state.ownerTurnRow) {
    if (!["queued", "running", "abort_requested"].includes(state.ownerTurnRow.status)) {
      void scheduleSessionSnapshot(input.sessionId, state.ownerTurnRow.sequence);
    }
    const turn = toTurnRecord(state.ownerTurnRow);
    await publishRealtimeEnvelope({
      domain: "session",
      type: "session.turn.updated",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      payload: { turn },
    }).catch((error) => logger.warn("[Compaction] failed to publish owner turn update", error));
  }
  if (state.messageRow) {
    await publishMessagePersisted(input.spaceId, toMessageRecord(state.messageRow)).catch((error) => {
      logger.warn("[Compaction] failed to publish compact message persisted", error);
    });
    await enqueueSessionMessagePostprocess({ sessionId: input.sessionId, message: state.messageRow }).catch((error) => logger.warn("[Compaction] failed to enqueue usage postprocess", error));
  }

  logger.info(
    `[Compaction] persisted scope=${input.scope} turnSeq=${state.compactSequence ?? "inline"} msgSeq=${state.messageSequence} sessionId=${input.sessionId}`,
  );

  return state.messageRow
    ? {
        compactTurnId: state.turnRow?.id ?? null,
        compactSequence: state.compactSequence,
        messageSequence: state.messageSequence,
      }
    : null;
}
