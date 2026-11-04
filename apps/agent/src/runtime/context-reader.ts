import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, sql, type SQL } from "drizzle-orm";
import { sessionMessages, sessionTurns, sessionTurnSegments, spaceSessions } from "@cohub/db";
import { findLatestCompactionIndex, harnessArchiveIndexSchema, isLocalHarness, LOCAL_HARNESSES, selectRuntimeContextMessages, type HarnessKind, type RuntimeContext, type RuntimeContextMessage } from "@cohub/protocol";
import type { db } from "../db.js";

type ContextInput = { spaceId: string; sessionId: string; beforeSequence?: number; throughTurnId?: string; harness?: HarnessKind; headOnly?: boolean; pendingTurnIds?: string[] };
type ContextDatabase = Pick<typeof db, "select">;
type ContextReaderDatabase = Pick<typeof db, "select" | "transaction">;
type TurnRange = { sourceSessionId: string; fromSequence: number; toSequence: number | null };
const asMeta = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const UNSETTLED_TURN_STATUSES = new Set(["running", "abort_requested"]);
const hasUnsettledTurn = (statuses: Array<string | null | undefined>) => statuses.some((status) => status != null && UNSETTLED_TURN_STATUSES.has(status));
const COMPACTED_NOTE = { type: "system_note", note_type: "compacted" } as const;
const CONTEXT_TURN_PAGE = 200;

/**
 * Position of the compaction `selectRuntimeContextMessages` will keep, so history before it is never read.
 * Candidates come from the small `role = 'system'` partial index and are ranked by the same function.
 * Compact Turns always have their message (same transaction), so the Turn fallback adds no candidates.
 */
async function findCompactionStart(database: ContextDatabase, ranges: TurnRange[], predicate: (range: TurnRange) => SQL | undefined) {
  const candidates: Array<RuntimeContextMessage & { rangeIndex: number; turnSequence: number }> = [];
  for (const [rangeIndex, range] of ranges.entries()) {
    const rows = await database.select({
      id: sessionMessages.id, turnId: sessionTurns.id, turnSequence: sessionTurns.sequence, createdAt: sessionMessages.createdAt,
      compactedAt: sql<unknown>`${sessionMessages.meta}->'compaction'->'compactedAt'`.mapWith(sessionMessages.meta),
    }).from(sessionMessages)
      .innerJoin(sessionTurns, eq(sessionMessages.turnId, sessionTurns.id))
      // Literal role keeps the partial index provable for the planner.
      .where(and(predicate(range), eq(sessionMessages.sessionId, range.sourceSessionId), eq(sessionMessages.sessionId, sessionTurns.sessionId),
        sql`${sessionMessages.role} = 'system'`, sql`${sessionMessages.content} @> ${JSON.stringify([COMPACTED_NOTE])}::jsonb`))
      .orderBy(asc(sessionTurns.sequence), asc(sessionMessages.sequence));
    candidates.push(...rows.map((row) => ({
      id: row.id, turnId: row.turnId, role: "system" as const, content: [{ ...COMPACTED_NOTE, text: "" }],
      meta: { compaction: { compactedAt: row.compactedAt }, createdAt: row.createdAt?.toISOString() }, rangeIndex, turnSequence: row.turnSequence,
    })));
  }
  return candidates[findLatestCompactionIndex(candidates)] ?? null;
}

type PageTurn = { id: string; sequence: number; status: string; metaIntent: string | null };

/**
 * One keyset page: messages by turn_id (no join; a join lets the planner rescan the session index per Turn),
 * plus full content only for the few Turns without message rows.
 */
async function loadTurnPage(database: ContextDatabase, sessionId: string, turns: PageTurn[]) {
  const sequenceOf = new Map(turns.map((turn) => [turn.id, turn.sequence]));
  const rows = (await database.select({
    id: sessionMessages.id, sessionId: sessionMessages.sessionId, turnId: sessionMessages.turnId, sequence: sessionMessages.sequence, role: sessionMessages.role,
    content: sessionMessages.content, provider: sessionMessages.provider, model: sessionMessages.model, usage: sessionMessages.usage,
    stopReason: sessionMessages.stopReason, errorMessage: sessionMessages.errorMessage, meta: sessionMessages.meta, createdAt: sessionMessages.createdAt,
  }).from(sessionMessages).where(inArray(sessionMessages.turnId, [...sequenceOf.keys()])))
    .filter((row) => row.sessionId === sessionId)
    // Turn order first: a note written during an agent turn must follow that turn.
    .sort((left, right) => (sequenceOf.get(left.turnId!)! - sequenceOf.get(right.turnId!)!) || left.sequence - right.sequence);
  const present = new Set(rows.map((row) => row.turnId));
  const missing = turns.filter((turn) => !present.has(turn.id) && turn.status !== "cancelled").map((turn) => turn.id);
  const fallback = missing.length ? await database.select({
    id: sessionTurns.id, sequence: sessionTurns.sequence, intent: sessionTurns.intent, userContent: sessionTurns.userContent,
    assistantContent: sessionTurns.assistantContent, provider: sessionTurns.provider, model: sessionTurns.model, createdAt: sessionTurns.createdAt,
    userMessageId: sql<unknown>`${sessionTurns.meta}->'userMessageId'`.mapWith(sessionTurns.meta),
    compaction: sql<unknown>`${sessionTurns.meta}->'compaction'`.mapWith(sessionTurns.meta),
  }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), inArray(sessionTurns.id, missing))).orderBy(asc(sessionTurns.sequence)) : [];
  return { turns, rows, fallback };
}

function appendTurnPage(messages: RuntimeContextMessage[], { turns, rows, fallback }: Awaited<ReturnType<typeof loadTurnPage>>) {
  const shellTurns = new Set(turns.filter((turn) => turn.metaIntent === "shell_command").map((turn) => turn.id));
  const sequenceOf = new Map(turns.map((turn) => [turn.id, turn.sequence]));
  let fallbackIndex = 0;
  const appendFallback = (turn: typeof fallback[number]) => {
    if (turn.userContent.length) messages.push({ id: typeof turn.userMessageId === "string" ? turn.userMessageId : `${turn.id}:user`, turnId: turn.id, role: "user", content: turn.userContent });
    if (turn.assistantContent?.length) messages.push({ id: `${turn.id}:assistant`, turnId: turn.id, role: turn.intent === "compact" ? "system" : "assistant", content: turn.assistantContent, provider: turn.provider, model: turn.model, meta: { compaction: turn.compaction ?? undefined, createdAt: turn.createdAt?.toISOString() } });
  };
  for (const message of rows) {
    const turnId = message.turnId!;
    for (let turn = fallback[fallbackIndex]; turn && turn.sequence < sequenceOf.get(turnId)!; turn = fallback[++fallbackIndex]) appendFallback(turn);
    const meta = asMeta(message.meta);
    const shellResult = shellTurns.has(turnId) && message.role === "assistant";
    messages.push({
      id: message.id, turnId, role: message.role as RuntimeContextMessage["role"], content: message.content,
      provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason, errorMessage: message.errorMessage,
      meta: { agentSessionEntryId: meta.agentSessionEntryId ?? null, messageKind: shellResult ? "shell_command_result" : meta.messageKind,
        compaction: meta.compaction, nativeApi: meta.nativeApi, generationTaskId: meta.generationTaskId, generationStatus: meta.generationStatus,
        command: meta.command, llmContextText: meta.llmContextText, createdAt: message.createdAt?.toISOString(),
      },
    });
  }
  for (let turn = fallback[fallbackIndex]; turn; turn = fallback[++fallbackIndex]) appendFallback(turn);
}

/** The hot path reads indexed boundary rows, never the complete conversation. */
export function createRuntimeContextReader(database: ContextReaderDatabase) {
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
    const predicate = (range: TurnRange) => and(
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
      if (input.pendingTurnIds.length > LOCAL_HARNESSES.length) throw new Error("Too many pending Runtime projections");
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

    // One snapshot for every page: a concurrent compaction re-sequences Turns and must not shift the cursor.
    await database.transaction(async (tx) => {
      // Literal statuses keep the active partial index provable; covers history before the compaction start too.
      const unsettled = await Promise.all(ranges.map((range) => tx.select({ id: sessionTurns.id }).from(sessionTurns)
        .where(and(predicate(range), sql`${sessionTurns.status} in ('running', 'abort_requested')`)).limit(1)));
      if (unsettled.some((rows) => rows.length)) throw new Error("Cannot resume before an earlier turn has settled");
      const start = await findCompactionStart(tx, ranges, predicate);
      for (const [rangeIndex, range] of ranges.entries()) {
        if (start && rangeIndex < start.rangeIndex) continue;
        let after = start?.rangeIndex === rangeIndex ? start.turnSequence - 1 : null;
        for (;;) {
          // Keyset pages bound each statement and its result set. Only direct shell commands (always
          // `steer` Turns) carry `meta.intent`, so the large meta is not decompressed for any other Turn.
          const turns = await tx.select({ id: sessionTurns.id, sequence: sessionTurns.sequence, status: sessionTurns.status,
            metaIntent: sql<string | null>`case when ${sessionTurns.intent} = 'steer' then ${sessionTurns.meta}->>'intent' end` }).from(sessionTurns)
            .where(and(predicate(range), after == null ? undefined : gt(sessionTurns.sequence, after)))
            .orderBy(asc(sessionTurns.sequence)).limit(CONTEXT_TURN_PAGE);
          const last = turns.at(-1);
          if (!last) break;
          appendTurnPage(result.messages, await loadTurnPage(tx, range.sourceSessionId, turns));
          if (turns.length < CONTEXT_TURN_PAGE) break;
          after = last.sequence;
        }
      }
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    result.messages = selectRuntimeContextMessages(result.messages);
    return result;
  };
}

/**
 * The newest settled explicit selection stored as `meta.<key>` before
 * `beforeSequence`, following fork segments from newest to oldest. Thinking level
 * comes from the composer model picker; context window from the prompt API.
 */
function createRequestedTurnMetaReader(database: ContextDatabase, key: "requestedThinkingLevel" | "requestedContextWindow") {
  return async function load(input: { sessionId: string; beforeSequence?: number }): Promise<string | null> {
    const segments = await database.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, input.sessionId)).orderBy(desc(sessionTurnSegments.ordinal));
    const ranges = segments.length ? segments : [{ sourceSessionId: input.sessionId, fromSequence: 1, toSequence: null }];
    const requested = sql<string | null>`${sessionTurns.meta}->>${sql.raw(`'${key}'`)}`;
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

export function createRequestedThinkingLevelReader(database: ContextDatabase) {
  return createRequestedTurnMetaReader(database, "requestedThinkingLevel");
}

export function createRequestedContextWindowReader(database: ContextDatabase) {
  const load = createRequestedTurnMetaReader(database, "requestedContextWindow");
  return async (input: { sessionId: string; beforeSequence?: number }): Promise<number | null> => {
    const value = Number(await load(input));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
}
