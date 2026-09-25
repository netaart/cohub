import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { hasPermission } from "./permissions.js";
import { sessionMessages, sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import { NATIVE_SYNC_SOURCE, SETTLED_TURN_STATUSES, isNativeClientTurn, type NativeTurnStart, type NativeTurnBinding, type NativeTurnComplete, type NativeIngest, type NativeIngestResult, type NativeKnownResult } from "@cohub/protocol";
import { addSessionParticipantMeta, deriveMessagePreviewText, deriveSessionFallbackTitle, runtimeResolutionOpen } from "@cohub/core/sessions";
import { sanitizeContentBlocksForPostgresJson, sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { db } from "./db/index.js";
import { createSessionForkInTransaction, findSegmentForTurn, publishSessionFork } from "./session-forks.js";
import { addUsage, buildIntermediateObjectsForTurn } from "./session-turns.js";
import { adoptNativeStreamSnapshot, cacheNativeTurnBinding, clearNativeTurnBinding, releaseNativeStreamSnapshot } from "./native-turn-progress.js";
import { enqueueAgentTurnJob } from "./agent-turn-queue.js";
import { createLogger } from "@cohub/infra/logging";

const nativeLogger = createLogger({ serviceName: "cohub-api" });
const terminal = new Set<string>(SETTLED_TURN_STATUSES);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export class NativeTurnError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) { super(message); }
}
const conflict = (message: string): never => { throw new NativeTurnError(409, message); };
const nativePermissionError = (): never => { throw new NativeTurnError(403, "No permission to prompt this Session"); };

/** Runtime lease holders keep space-level authority, but Session-level prompt rules still apply. */
async function assertSessionPromptPermission(spaceId: string, userId: string, sessionId: string) {
  if (!await hasPermission({ uuid: userId }, "session.prompt.fullaccess", { spaceId, sessionId })) nativePermissionError();
}

function messageId(turnId: string, ordinal: number) {
  return stableUuid([turnId, ordinal]);
}

/** Deterministic v5-shaped id: a replayed native Turn always names the same branch Session. */
function stableUuid(value: unknown) {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Session summaries are projections; they must not be able to roll back a durable Turn. */
async function projectNativeSession(input: { sessionId: string; userId?: string; title?: string | null; latestMessageText?: string | null; lastMessageId?: string; lastMessageAt?: Date }) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ meta: spaceSessions.meta }).from(spaceSessions).where(eq(spaceSessions.id, input.sessionId)).for("update");
    if (!current) throw new Error("Native Session disappeared before projection");
    const messageAt = input.lastMessageAt?.toISOString();
    const newestMessage = messageAt ? sql`(${spaceSessions.lastMessageAt} is null or ${spaceSessions.lastMessageAt} <= ${messageAt}::timestamptz)` : null;
    const [session] = await tx.update(spaceSessions).set({
      ...(input.userId ? { meta: sanitizePostgresJsonValue(addSessionParticipantMeta(current.meta, input.userId)) } : {}),
      ...(input.title != null ? { title: sql`coalesce(${spaceSessions.title}, ${input.title})` } : {}),
      ...(input.latestMessageText !== undefined ? { latestMessageText: newestMessage ? sql`case when ${newestMessage} then ${input.latestMessageText} else ${spaceSessions.latestMessageText} end` : input.latestMessageText } : {}),
      ...(input.lastMessageId ? { lastMessageId: newestMessage ? sql`case when ${newestMessage} then ${input.lastMessageId} else ${spaceSessions.lastMessageId} end` : input.lastMessageId } : {}),
      ...(messageAt ? { lastMessageAt: sql`greatest(coalesce(${spaceSessions.lastMessageAt}, ${messageAt}::timestamptz), ${messageAt}::timestamptz)` } : {}),
      updatedAt: new Date(),
    }).where(eq(spaceSessions.id, input.sessionId)).returning();
    if (!session) throw new Error("Failed to update native Session projection");
    return session;
  });
}

async function bestEffortNativeSessionProjection(input: Parameters<typeof projectNativeSession>[0]) {
  try { return await projectNativeSession(input); }
  catch (error) {
    nativeLogger.error("[NativeTurn] Session projection failed", { sessionId: input.sessionId, error });
    return null;
  }
}

/** Shares the Session row lock with createSessionTurn and the Agent's batch claim. */
export async function startNativeTurn(spaceId: string, userId: string, input: NativeTurnStart) {
  // Controllability can change while a Turn runs; it is state, not part of the Turn's identity.
  const { controllable, ...identity } = input;
  const requestDigest = digest(identity);
  const committed = await db.transaction(async (tx) => {
    // Retries may name the original parent even after the first request forked. Serialize by receipt ID first.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.turnId}, 0))`);
    const [existing] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1);
    if (existing) {
      const meta = record(existing.meta);
      const receipt = record(meta.nativeSync);
      if (existing.userUuid !== userId || receipt.spaceId !== spaceId || receipt.requestDigest !== requestDigest) conflict("Native Turn identity mismatch");
      // Re-verify on retry: a permission revoked after the first start must stop future receipts.
      await assertSessionPromptPermission(spaceId, userId, existing.sessionId);
      const [session] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, existing.sessionId));
      if (!session) throw new NativeTurnError(404, "Session not found");
      const userContent = sanitizeContentBlocksForPostgresJson(input.userContent);
      return { binding: { sessionId: session.id, turnId: existing.id, forked: input.sessionId !== null && session.id !== input.sessionId }, session, created: false, sessionCreated: false, fork: null,
        projection: { userText: deriveMessagePreviewText({ content: userContent }) || null, userMessageId: messageId(input.turnId, -1), startedAt: new Date(input.startedAt), title: deriveSessionFallbackTitle({ content: userContent }) } };
    }

    let sessionId = input.sessionId;
    let sessionCreated = false;
    let fork: Awaited<ReturnType<typeof createSessionForkInTransaction>> | null = null;
    let sequence = 1;
    if (sessionId) {
      const [parent] = await tx.select().from(spaceSessions).where(and(eq(spaceSessions.id, sessionId), eq(spaceSessions.spaceId, spaceId))).for("update").limit(1);
      if (!parent) throw new NativeTurnError(404, "Session not found");
      // Same gate as regular prompt submission: Runtime lease authority is not Session-level authority.
      await assertSessionPromptPermission(spaceId, userId, sessionId);
      let segments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
      if (!segments.length) segments = await tx.insert(sessionTurnSegments).values({ sessionId, ordinal: 1, sourceSessionId: sessionId, fromSequence: 1, toSequence: null }).returning();
      let anchor: typeof sessionTurns.$inferSelect | undefined;
      if (input.parentTurnId) {
        [anchor] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, input.parentTurnId)).limit(1);
        if (!anchor || !terminal.has(anchor.status) || !findSegmentForTurn(segments, { sourceSessionId: anchor.sessionId, sequence: anchor.sequence })) conflict("Fork requires a visible, settled Turn");
      }
      let head: typeof sessionTurns.$inferSelect | undefined;
      for (const segment of segments) {
        const [candidate] = await tx.select().from(sessionTurns).where(and(
          eq(sessionTurns.sessionId, segment.sourceSessionId),
          sql`${sessionTurns.sequence} >= ${segment.fromSequence}`,
          segment.toSequence === null ? undefined : sql`${sessionTurns.sequence} <= ${segment.toSequence}`,
        )).orderBy(desc(sessionTurns.sequence)).limit(1);
        if (candidate && (!head || candidate.sequence > head.sequence)) head = candidate;
      }
      const [unfinished] = await tx.select({ id: sessionTurns.id }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), notInArray(sessionTurns.status, [...SETTLED_TURN_STATUSES]))).limit(1);
      const canAppend = !unfinished && (head?.id ?? null) === input.parentTurnId && (!head || terminal.has(head.status));
      if (canAppend) sequence = (head?.sequence ?? 0) + 1;
      else if (anchor) {
        const [collision] = await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, input.branchSessionId));
        if (collision) conflict("Branch Session identity already exists");
        fork = await createSessionForkInTransaction(tx, { spaceId, parentSessionId: sessionId, childSessionId: input.branchSessionId, turnId: anchor.id, sequence: anchor.sequence, createdBy: userId });
        sessionId = fork.session.id;
        sessionCreated = true;
        sequence = anchor.sequence + 1;
      } else sessionId = null; // Empty local history has no Turn to fork: create an independent root.
    }
    if (!sessionId) {
      sessionId = input.branchSessionId;
      sessionCreated = true;
      const [collision] = await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, sessionId));
      if (collision) conflict("Session identity already exists");
      const sessionMeta = input.origin ? {
        nativeSync: { version: 1, origin: input.origin, harness: input.harness, nativeSessionId: input.nativeSessionId, originalStartedAt: input.sessionStartedAt ?? input.startedAt },
      } : {};
      const sessionStartedAt = new Date(input.sessionStartedAt ?? input.startedAt);
      await tx.insert(spaceSessions).values({ id: sessionId, spaceId, userUuid: userId, source: NATIVE_SYNC_SOURCE,
        meta: addSessionParticipantMeta(sessionMeta, userId), createdAt: sessionStartedAt });
      await tx.insert(sessionTurnSegments).values({ sessionId, ordinal: 1, sourceSessionId: sessionId, fromSequence: 1, toSequence: null });
    }
    const userContent = sanitizeContentBlocksForPostgresJson(input.userContent);
    const userText = deriveMessagePreviewText({ content: userContent }) || null;
    const startedAt = new Date(input.startedAt);
    const userMessageId = messageId(input.turnId, -1);
    const meta = {
      source: NATIVE_SYNC_SOURCE, harness: input.harness, runtime: "local", actorUserId: userId, userMessageId,
      runtimeRecovery: { state: "executing", ownerUserId: userId },
      nativeSync: { version: 1, spaceId, requestDigest, nativeSessionId: input.nativeSessionId, parentTurnId: input.parentTurnId, observedAt: new Date().toISOString(),
        ...(input.origin ? { origin: input.origin, originalStartedAt: input.startedAt } : {}),
        ...(controllable === undefined ? {} : { controllable }) },
    };
    await tx.insert(sessionTurns).values({ id: input.turnId, sessionId, userUuid: userId, sequence, status: "running", intent: "followup", userContent, userText, meta, startedAt, createdAt: startedAt });
    const [last] = await tx.select({ sequence: sessionMessages.sequence }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(desc(sessionMessages.sequence)).limit(1);
    await tx.insert(sessionMessages).values({ id: userMessageId, sessionId, turnId: input.turnId, role: "user", content: userContent, text: userText, sequence: (last?.sequence ?? 0) + 1, idempotencyKey: `native:${input.turnId}:user`, meta: { ...meta, turnId: input.turnId, messageKind: "user" }, startedAt, completedAt: startedAt, createdAt: startedAt });
    const [session] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, sessionId)).limit(1);
    if (!session) throw new Error("Native Session disappeared before commit");
    const binding: NativeTurnBinding = { sessionId, turnId: input.turnId, forked: input.sessionId !== null && sessionId !== input.sessionId };
    return { binding, session, created: true, sessionCreated, fork, projection: { userText, userMessageId, startedAt, title: deriveSessionFallbackTitle({ content: userContent }) } };
  });
  if (!committed.projection) return committed;
  const projection = committed.projection;
  const session = await bestEffortNativeSessionProjection({ sessionId: committed.binding.sessionId, userId, title: projection.title,
    latestMessageText: projection.userText, lastMessageId: projection.userMessageId, lastMessageAt: projection.startedAt }) ?? committed.session;
  return { ...committed, session };
}

/** Follow-up work of an ingest batch, performed after the response; never part of the wire result. */
export type NativeIngestEffects = {
  createdSessions: string[];
  turns: Array<{ sessionId: string; turnId: string; created: boolean; changed: boolean; imported: boolean }>;
};

/**
 * Ingest one transcript's Turns in order. Every Turn is independently idempotent, which is what
 * lets a Runtime resume from the server instead of keeping local delivery receipts.
 */
export async function ingestNativeTurns(spaceId: string, userId: string, input: NativeIngest): Promise<NativeIngestResult & { effects: NativeIngestEffects }> {
  const turns: NativeIngestResult["turns"] = [];
  const effects: NativeIngestEffects = { createdSessions: [], turns: [] };
  const sessions = new Map<string, string>();
  const drain = new Set<string>();
  for (const turn of input.turns) {
    // A continuation names its parent Turn; the Session follows that parent, including a fork
    // created by an earlier Turn of the same transcript.
    let sessionId: string | null = null;
    if (turn.parentTurnId) {
      sessionId = sessions.get(turn.parentTurnId) ?? null;
      if (!sessionId) {
        const [parent] = await db.select({ sessionId: sessionTurns.sessionId }).from(sessionTurns)
          .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
          .where(and(eq(sessionTurns.id, turn.parentTurnId), eq(spaceSessions.spaceId, spaceId))).limit(1);
        sessionId = parent?.sessionId ?? conflict("Parent Turn is not recorded; send the transcript in order");
      }
    }
    const start: NativeTurnStart = {
      turnId: turn.turnId, sessionId, parentTurnId: turn.parentTurnId, branchSessionId: stableUuid([turn.turnId, "branch"]),
      harness: input.harness, nativeSessionId: input.nativeSessionId, userContent: turn.userContent, startedAt: turn.startedAt,
      ...(turn.origin ? { origin: turn.origin } : {}),
      ...(turn.controllable === undefined ? {} : { controllable: turn.controllable }),
    };
    const { binding, created, sessionCreated, fork } = await startNativeTurn(spaceId, userId, start);
    let changed = false;
    if (turn.result) {
      changed = await completeNativeTurn(spaceId, userId, binding.sessionId, binding.turnId, turn.result).then((outcome) => outcome.changed, (error: unknown) => {
        // The server already decided this Turn (a confirmed stop, or a different final result).
        if (!(error instanceof NativeTurnError) || error.status !== 409) throw error;
        nativeLogger.warn("[NativeTurn] native result kept out of a settled Turn", { spaceId, turnId: binding.turnId, reason: error.message });
        return false;
      });
      await clearNativeTurnBinding(binding.turnId);
      if (changed) await releaseNativeStreamSnapshot(spaceId, binding.sessionId, binding.turnId);
      // Every settled Turn may unblock queued work, replays included: a batch that failed after its
      // writes is replayed with `changed: false` and must still wake the Session.
      drain.add(binding.sessionId);
    } else {
      // An executing Turn accepts live progress; its stream snapshot is taken over atomically.
      const userMessageId = messageId(binding.turnId, -1);
      await cacheNativeTurnBinding({ ...binding, spaceId, ownerUserId: userId, userMessageId });
      await adoptNativeStreamSnapshot(spaceId, binding.sessionId, binding.turnId, userMessageId);
    }
    if (fork) await publishSessionFork(fork).catch((error) => nativeLogger.warn("[NativeTurn] fork publish failed", { error }));
    if (sessionCreated) effects.createdSessions.push(binding.sessionId);
    if (created || changed) effects.turns.push({ sessionId: binding.sessionId, turnId: binding.turnId, created, changed, imported: turn.origin === "local_import" });
    turns.push({ turnId: binding.turnId, sessionId: binding.sessionId, forked: binding.forked, settled: Boolean(turn.result), created, changed });
    sessions.set(binding.turnId, binding.sessionId);
  }
  // The wakeup job is idempotent per Session; one per Session per batch.
  for (const sessionId of drain) await enqueueAgentTurnJob({ spaceId, sessionId, reason: "drain" });
  return { turns, effects };
}

/** Which of these Turns this Space already recorded, and whether each has settled. */
export async function knownNativeTurns(spaceId: string, turnIds: string[]): Promise<NativeKnownResult> {
  if (!turnIds.length) return { turns: [] };
  const rows = await db.select({ turnId: sessionTurns.id, sessionId: sessionTurns.sessionId, status: sessionTurns.status }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(eq(spaceSessions.spaceId, spaceId), inArray(sessionTurns.id, turnIds)));
  return { turns: rows.map((row) => ({ turnId: row.turnId, sessionId: row.sessionId, settled: terminal.has(row.status) })) };
}

/**
 * The Runtime (re)connected, a native client came or went, or the Turn showed signs of life: it is
 * alive and executing, and whether Cohub can stop it is updated.
 */
export async function observeNativeTurn(spaceId: string, userId: string, sessionId: string, turnId: string, controllable?: boolean) {
  const turn = await getOwnedNativeTurn(spaceId, userId, sessionId, turnId);
  let meta = sql`jsonb_set(jsonb_set(${sessionTurns.meta}, '{nativeSync,observedAt}', to_jsonb(${new Date().toISOString()}::text)), '{runtimeRecovery,state}', '"executing"'::jsonb)`;
  if (controllable !== undefined) meta = sql`jsonb_set(${meta}, '{nativeSync,controllable}', ${controllable ? sql`'true'::jsonb` : sql`'false'::jsonb`})`;
  // Restore liveness and the executing state so the attention watchdog only fires on real silence.
  await db.update(sessionTurns).set({ meta })
    .where(and(eq(sessionTurns.id, turnId), inArray(sessionTurns.status, ["running", "abort_requested"]), runtimeResolutionOpen));
  return { abortRequested: turn.status === "abort_requested", status: turn.status };
}

export async function getOwnedNativeTurn(spaceId: string, userId: string, sessionId: string, turnId: string) {
  const [row] = await db.select({ turn: sessionTurns }).from(sessionTurns).innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(eq(spaceSessions.spaceId, spaceId), eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.id, turnId))).limit(1);
  if (!row) throw new NativeTurnError(404, "Turn not found");
  if (row.turn.userUuid !== userId || !isNativeClientTurn(row.turn.meta) || record(record(row.turn.meta).nativeSync).spaceId !== spaceId) throw new NativeTurnError(403, "Native Turn owner mismatch");
  return row.turn;
}

/** Completion, messages and terminal state commit atomically; object-storage artifacts retry separately. */
export async function completeNativeTurn(spaceId: string, userId: string, sessionId: string, turnId: string, input: NativeTurnComplete) {
  await getOwnedNativeTurn(spaceId, userId, sessionId, turnId);
  const completionDigest = digest(input);
  const committed = await db.transaction(async (tx) => {
    await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, sessionId)).for("update");
    const [turn] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)).for("update");
    if (!turn) throw new NativeTurnError(404, "Turn not found");
    const meta = record(turn.meta), receipt = record(meta.nativeSync);
    const imported = receipt.origin === "local_import";
    if (record(meta.runtimeRecovery).state === "confirmed_stopped") conflict("Execution was resolved; retain the local receipt");
    if (receipt.completionDigest && receipt.completionDigest !== completionDigest) conflict("Turn result is immutable");
    if (terminal.has(turn.status)) {
      // Replay of the exact same completion: only the artifact snapshot may still be missing.
      if (receipt.completionDigest !== completionDigest) conflict("Turn already finalized");
      return { changed: false, turn, messages: [], projection: null };
    }
    const completedAt = new Date(input.completedAt);
    const messages = input.messages.map((message, ordinal): typeof sessionMessages.$inferSelect => {
      const final = ordinal === input.messages.length - 1;
      const content = sanitizeContentBlocksForPostgresJson(message.content);
      return {
        id: messageId(turnId, ordinal), sessionId, turnId, role: "assistant", content, text: deriveMessagePreviewText({ content }) || null,
        sequence: ordinal, idempotencyKey: `native:${turnId}:${ordinal}`, provider: message.provider ?? null, model: message.model ?? null,
        stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ? sanitizePostgresJsonValue(message.errorMessage) : null, usage: message.usage ?? null,
        meta: { turnId, messageOrdinal: ordinal, harness: record(turn.meta).harness, runtime: "local", source: NATIVE_SYNC_SOURCE, actorUserId: userId, anchorUserMessageId: record(turn.meta).userMessageId,
          ...(imported ? { origin: "local_import", originalStartedAt: turn.startedAt, originalCompletedAt: input.completedAt } : {}),
          messageKind: final ? input.status === "completed" ? "assistant_final" : "assistant_error" : "assistant_intermediate" },
        startedAt: turn.startedAt, completedAt, durationMs: null, usageAggregatedAt: null, createdAt: completedAt,
      };
    });
    const final = messages.at(-1);
    const totalUsage = messages.reduce<ReturnType<typeof addUsage>>((sum, message) => addUsage(sum, message.usage), null);
    const [last] = await tx.select({ sequence: sessionMessages.sequence }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(desc(sessionMessages.sequence)).limit(1);
    if (messages.length) await tx.insert(sessionMessages).values(messages.map((message, ordinal) => ({ ...message, sequence: (last?.sequence ?? 0) + ordinal + 1, meta: sanitizePostgresJsonValue(message.meta) })));
    const next = await tx.update(sessionTurns).set({ status: input.status, assistantContent: final?.content ?? [], assistantText: final?.text ?? null,
      provider: final?.provider ?? null, model: final?.model ?? null, stopReason: input.status === "interrupted" ? "aborted" : final?.stopReason ?? (input.status === "failed" ? "error" : "stop"),
      errorMessage: final?.errorMessage ?? null, finalUsage: final?.usage ?? null, totalUsage,
      summary: { text: final?.text ?? null, finishReason: input.status },
      completedAt, durationMs: Math.min(2_147_483_647, Math.max(0, completedAt.getTime() - (turn.startedAt?.getTime() ?? completedAt.getTime()))), updatedAt: new Date(),
      meta: { ...meta, runtimeArchiveStatus: "pending", nativeSync: { ...receipt, completionDigest, ...(imported ? { originalCompletedAt: input.completedAt } : {}) } },
    }).where(and(eq(sessionTurns.id, turnId), runtimeResolutionOpen, inArray(sessionTurns.status, ["running", "abort_requested"]))).returning();
    if (!next) conflict("Execution was resolved");
    return { changed: true, turn: next, messages, projection: { latestMessageText: final?.text ?? turn.userText, lastMessageId: final?.id, completedAt } };
  });
  if (committed.changed && committed.projection) {
    await bestEffortNativeSessionProjection({ sessionId, latestMessageText: committed.projection.latestMessageText,
      ...(committed.projection.lastMessageId ? { lastMessageId: committed.projection.lastMessageId } : {}), lastMessageAt: committed.projection.completedAt });
  }
  let artifactsPending = false;
  if (committed.changed) {
    // Durable-first: the terminal Turn state never rolls back; a failed artifact snapshot keeps the
    // receipt unacknowledged so the Daemon replays this exact completion on its next flush cycle.
    const intermediate = await buildIntermediateObjectsForTurn({ spaceId, sessionId, turnId }, committed.messages).catch(() => null);
    if (intermediate) await db.update(sessionTurns).set({ intermediateIndex: intermediate.index, intermediateSummary: intermediate.summary }).where(eq(sessionTurns.id, turnId));
    else artifactsPending = true;
  } else {
    // Exact-replay path: refill only a still-missing artifact snapshot from the persisted messages.
    const [final] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)).limit(1);
    if (!final?.intermediateSummary) {
      const persisted = await db.select().from(sessionMessages).where(and(eq(sessionMessages.turnId, turnId), eq(sessionMessages.role, "assistant"))).orderBy(asc(sessionMessages.sequence));
      const intermediate = await buildIntermediateObjectsForTurn({ spaceId, sessionId, turnId }, persisted).catch(() => null);
      if (intermediate) await db.update(sessionTurns).set({ intermediateIndex: intermediate.index, intermediateSummary: intermediate.summary }).where(eq(sessionTurns.id, turnId));
      else artifactsPending = true;
    }
  }
  return { completed: true as const, changed: committed.changed, artifactsPending, turn: committed.turn ?? null };
}
