import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { sessionMessages, sessionTurns, sessionTurnSegments, spaceSessions } from "@cohub/db";
import { harnessArchiveIndexSchema, isLocalHarness, selectRuntimeContextMessages, type HarnessKind, type RuntimeContext, type RuntimeContextMessage } from "@cohub/protocol";
import type { db } from "../db.js";

type ContextInput = { spaceId: string; sessionId: string; beforeSequence?: number; throughTurnId?: string; harness?: HarnessKind; headOnly?: boolean; pendingTurnIds?: string[] };
type ContextDatabase = Pick<typeof db, "select">;
const asMeta = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const UNSETTLED_TURN_STATUSES = new Set(["running", "abort_requested"]);
const hasUnsettledTurn = (statuses: Array<string | null | undefined>) => statuses.some((status) => status != null && UNSETTLED_TURN_STATUSES.has(status));

/** The hot path reads indexed boundary rows, never the complete conversation. */
export function createRuntimeContextReader(database: ContextDatabase) {
  return async function load(input: ContextInput): Promise<RuntimeContext> {
    const [session] = await database.select({ id: spaceSessions.id }).from(spaceSessions)
      .where(and(eq(spaceSessions.id, input.sessionId), eq(spaceSessions.spaceId, input.spaceId))).limit(1);
    if (!session) throw new Error("Session does not belong to Space");
    let beforeSequence = input.beforeSequence;
    if (input.throughTurnId) {
      const [turn] = await database.select({ sequence: sessionTurns.sequence }).from(sessionTurns)
        .where(and(eq(sessionTurns.id, input.throughTurnId), eq(sessionTurns.sessionId, input.sessionId))).limit(1);
      if (!turn) throw new Error("Context boundary turn not found");
      beforeSequence = turn.sequence + 1;
    }
    const segments = await database.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, input.sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
    const ranges = (segments.length ? segments : [{ sourceSessionId: input.sessionId, fromSequence: 1, toSequence: null }]).filter((range) => beforeSequence == null || range.fromSequence < beforeSequence);
    const predicate = (range: typeof ranges[number]) => and(
      eq(sessionTurns.sessionId, range.sourceSessionId), gte(sessionTurns.sequence, range.fromSequence),
      range.toSequence == null ? undefined : lte(sessionTurns.sequence, range.toSequence),
      beforeSequence == null ? undefined : lt(sessionTurns.sequence, beforeSequence), ne(sessionTurns.status, "queued"),
    );
    const heads = await Promise.all(ranges.map(async (range) => {
      const [head] = await database.select({ id: sessionTurns.id, sessionId: sessionTurns.sessionId, sequence: sessionTurns.sequence, status: sessionTurns.status, updatedAt: sessionTurns.updatedAt, harnessIndex: sessionTurns.harnessIndex, harness: sql<string | null>`${sessionTurns.meta}->>'harness'`, archiveStatus: sql<string | null>`${sessionTurns.meta}->>'runtimeArchiveStatus'`, recoveryState: sql<string | null>`${sessionTurns.meta}->'runtimeRecovery'->>'state'` })
        .from(sessionTurns).where(predicate(range)).orderBy(desc(sessionTurns.sequence)).limit(1);
      return head ?? null;
    }));
    const lastTurn = heads.filter((head) => head !== null).at(-1) ?? null;
    if (hasUnsettledTurn(heads.map((head) => head?.status))) throw new Error("Cannot resume before an earlier turn has settled");
    const revision = createHash("sha256").update(JSON.stringify(ranges.map((range, index) => [range.sourceSessionId, range.fromSequence, range.toSequence, heads[index]?.id, heads[index]?.sequence, heads[index]?.updatedAt]))).digest("hex");
    const result: RuntimeContext = { complete: !input.headOnly, revision, throughTurnId: lastTurn?.id ?? null, messages: [], resolvedTurnIds: [], settledTurnIds: [] };
    if (input.pendingTurnIds?.length) {
      if (input.pendingTurnIds.length > 2) throw new Error("Too many pending Runtime projections");
      const settled = await database.select({ id: sessionTurns.id, recoveryState: sql<string | null>`${sessionTurns.meta}->'runtimeRecovery'->>'state'` }).from(sessionTurns)
        .where(and(eq(sessionTurns.sessionId, input.sessionId), inArray(sessionTurns.id, input.pendingTurnIds),
          beforeSequence == null ? undefined : lt(sessionTurns.sequence, beforeSequence),
          inArray(sessionTurns.status, ["completed", "failed", "interrupted"])));
      result.resolvedTurnIds = settled.filter((turn) => turn.recoveryState === "confirmed_stopped").map((turn) => turn.id);
      result.settledTurnIds = settled.filter((turn) => turn.recoveryState !== "confirmed_stopped").map((turn) => turn.id);
    }
    if (input.harness && isLocalHarness(input.harness) && lastTurn?.sessionId === input.sessionId
      && lastTurn.archiveStatus === "ready" && lastTurn.recoveryState !== "confirmed_stopped") {
      const index = harnessArchiveIndexSchema.safeParse(lastTurn.harnessIndex);
      if (index.success && index.data.harness === input.harness && index.data.sessionId === input.sessionId && index.data.turnId === lastTurn.id) {
        result.archive = { sessionId: lastTurn.sessionId, turnId: lastTurn.id, harness: input.harness };
        result.complete = false; // Only the archive is supplied; DB history remains available on demand.
        return result;
      }
    }
    if (input.headOnly) return result;

    for (const range of ranges) {
      const turns = await database.select().from(sessionTurns).where(predicate(range)).orderBy(asc(sessionTurns.sequence));
      if (hasUnsettledTurn(turns.map((turn) => turn.status))) throw new Error("Cannot resume before an earlier turn has settled");
      // Legacy messages may have meta.turnId but no indexed turn_id yet.
      const rows = await database.select({ message: sessionMessages, turnId: sessionTurns.id, turnMeta: sessionTurns.meta, turnSequence: sessionTurns.sequence }).from(sessionMessages)
        .innerJoin(sessionTurns, or(eq(sessionMessages.turnId, sessionTurns.id), and(isNull(sessionMessages.turnId), sql`${sessionMessages.meta}->>'turnId' = ${sessionTurns.id}::text`)))
        .where(and(predicate(range), eq(sessionMessages.sessionId, sessionTurns.sessionId)))
        .orderBy(asc(sessionMessages.sequence));
      const present = new Set(rows.map((row) => row.turnId));
      const fallback = turns.filter((turn) => !present.has(turn.id) && turn.status !== "cancelled");
      let fallbackIndex = 0;
      const appendFallback = (turn: typeof turns[number]) => {
        const meta = asMeta(turn.meta);
        if (turn.userContent.length) result.messages.push({ id: typeof meta.userMessageId === "string" ? meta.userMessageId : `${turn.id}:user`, turnId: turn.id, role: "user", content: turn.userContent });
        if (turn.assistantContent?.length) result.messages.push({ id: `${turn.id}:assistant`, turnId: turn.id, role: turn.intent === "compact" ? "system" : "assistant", content: turn.assistantContent, provider: turn.provider, model: turn.model, meta: { compaction: meta.compaction, createdAt: turn.createdAt?.toISOString() } });
      };
      for (const { message, turnId, turnMeta, turnSequence } of rows) {
        while (fallback[fallbackIndex]?.sequence !== undefined && (fallback[fallbackIndex]?.sequence ?? Number.POSITIVE_INFINITY) < turnSequence) {
          const turn = fallback[fallbackIndex];
          fallbackIndex += 1;
          if (turn) appendFallback(turn);
        }
        const meta = asMeta(message.meta);
        const shellResult = asMeta(turnMeta).intent === "shell_command" && message.role === "assistant";
        result.messages.push({
          id: message.id, turnId, role: message.role as RuntimeContextMessage["role"], content: message.content,
          provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason, errorMessage: message.errorMessage,
          meta: { agentSessionEntryId: meta.agentSessionEntryId ?? null, messageKind: shellResult ? "shell_command_result" : meta.messageKind,
            compaction: meta.compaction, nativeApi: meta.nativeApi, generationTaskId: meta.generationTaskId, generationStatus: meta.generationStatus,
            command: meta.command, llmContextText: meta.llmContextText, createdAt: message.createdAt?.toISOString(),
          },
        });
      }
      while (fallback[fallbackIndex]) {
        const turn = fallback[fallbackIndex];
        fallbackIndex += 1;
        if (turn) appendFallback(turn);
      }
    }
    result.messages = selectRuntimeContextMessages(result.messages);
    return result;
  };
}

/**
 * The thinking level the user last selected explicitly (composer model picker),
 * i.e. the newest settled `meta.requestedThinkingLevel` before `beforeSequence`,
 * following fork segments from newest to oldest.
 */
export function createRequestedThinkingLevelReader(database: ContextDatabase) {
  return async function load(input: { sessionId: string; beforeSequence?: number }): Promise<string | null> {
    const segments = await database.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, input.sessionId)).orderBy(desc(sessionTurnSegments.ordinal));
    const ranges = segments.length ? segments : [{ sourceSessionId: input.sessionId, fromSequence: 1, toSequence: null }];
    const requested = sql<string | null>`${sessionTurns.meta}->>'requestedThinkingLevel'`;
    for (const range of ranges) {
      const [row] = await database.select({ level: requested }).from(sessionTurns)
        .where(and(
          eq(sessionTurns.sessionId, range.sourceSessionId), gte(sessionTurns.sequence, range.fromSequence),
          range.toSequence == null ? undefined : lte(sessionTurns.sequence, range.toSequence),
          input.beforeSequence == null ? undefined : lt(sessionTurns.sequence, input.beforeSequence),
          ne(sessionTurns.status, "queued"), sql`${requested} is not null`,
        ))
        .orderBy(desc(sessionTurns.sequence)).limit(1);
      if (row?.level) return row.level;
    }
    return null;
  };
}
