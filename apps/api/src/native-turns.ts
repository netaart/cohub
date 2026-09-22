import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { hasPermission } from "./permissions.js";
import { sessionMessages, sessionTurnSegments, sessionTurns, spaceSessions } from "@cohub/db";
import { NATIVE_SYNC_SOURCE, isNativeClientTurn, type NativeTurnStart, type NativeTurnBinding, type NativeTurnComplete } from "@cohub/protocol";
import { addSessionParticipantMeta, deriveMessagePreviewText, deriveSessionFallbackTitle, runtimeResolutionOpen } from "@cohub/core/sessions";
import { sanitizeContentBlocksForPostgresJson, sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { db } from "./db/index.js";
import { createSessionForkInTransaction, findSegmentForTurn } from "./session-forks.js";
import { addUsage, buildIntermediateObjectsForTurn } from "./session-turns.js";

const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "merged"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
export class NativeTurnError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) { super(message); }
}
const conflict = (message: string): never => { throw new NativeTurnError(409, message); };
const nativePermissionError = (): never => { throw new NativeTurnError(403, "No permission to prompt this Session / 无权限向此会话发送消息"); };

/** Runtime lease holders keep space-level authority, but Session-level prompt rules still apply. */
async function assertSessionPromptPermission(spaceId: string, userId: string, sessionId: string) {
  if (!await hasPermission({ uuid: userId }, "session.prompt.fullaccess", { spaceId, sessionId })) nativePermissionError();
}

function messageId(turnId: string, ordinal: number) {
  const hex = digest([turnId, ordinal]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Shares the Session row lock with createSessionTurn and the Agent's batch claim. */
export async function startNativeTurn(spaceId: string, userId: string, input: NativeTurnStart) {
  const requestDigest = digest(input);
  return db.transaction(async (tx) => {
    // Retries may name the original parent even after the first request forked. Serialize by receipt ID first.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.turnId}, 0))`);
    const [existing] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, input.turnId)).limit(1);
    if (existing) {
      const meta = record(existing.meta);
      const receipt = record(meta.nativeSync);
      if (existing.userUuid !== userId || receipt.spaceId !== spaceId || receipt.requestDigest !== requestDigest) conflict("Native Turn identity mismatch / 原生 Turn 身份不匹配");
      // Re-verify on retry: a permission revoked after the first start must stop future receipts.
      await assertSessionPromptPermission(spaceId, userId, existing.sessionId);
      const [session] = await tx.select().from(spaceSessions).where(eq(spaceSessions.id, existing.sessionId));
      if (!session) throw new NativeTurnError(404, "Session not found / 会话不存在");
      return { binding: { sessionId: session.id, turnId: existing.id, forked: input.sessionId !== null && session.id !== input.sessionId }, session, created: false, fork: null };
    }

    let sessionId = input.sessionId;
    let fork: Awaited<ReturnType<typeof createSessionForkInTransaction>> | null = null;
    let sequence = 1;
    if (sessionId) {
      const [parent] = await tx.select().from(spaceSessions).where(and(eq(spaceSessions.id, sessionId), eq(spaceSessions.spaceId, spaceId))).for("update").limit(1);
      if (!parent) throw new NativeTurnError(404, "Session not found / 会话不存在");
      // Same gate as regular prompt submission: Runtime lease authority is not Session-level authority.
      await assertSessionPromptPermission(spaceId, userId, sessionId);
      let segments = await tx.select().from(sessionTurnSegments).where(eq(sessionTurnSegments.sessionId, sessionId)).orderBy(asc(sessionTurnSegments.ordinal));
      if (!segments.length) segments = await tx.insert(sessionTurnSegments).values({ sessionId, ordinal: 1, sourceSessionId: sessionId, fromSequence: 1, toSequence: null }).returning();
      let anchor: typeof sessionTurns.$inferSelect | undefined;
      if (input.parentTurnId) {
        [anchor] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, input.parentTurnId)).limit(1);
        if (!anchor || !terminal.has(anchor.status) || !findSegmentForTurn(segments, { sourceSessionId: anchor.sessionId, sequence: anchor.sequence })) conflict("Fork requires a visible, settled Turn / 分支需要可见且已结束的 Turn");
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
      const [unfinished] = await tx.select({ id: sessionTurns.id }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), notInArray(sessionTurns.status, ["completed", "failed", "interrupted", "cancelled", "merged"]))).limit(1);
      const canAppend = !unfinished && (head?.id ?? null) === input.parentTurnId && (!head || terminal.has(head.status));
      if (canAppend) sequence = (head?.sequence ?? 0) + 1;
      else if (anchor) {
        const [collision] = await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, input.branchSessionId));
        if (collision) conflict("Branch Session identity already exists / 分支会话身份已存在");
        fork = await createSessionForkInTransaction(tx, { spaceId, parentSessionId: sessionId, childSessionId: input.branchSessionId, turnId: anchor.id, sequence: anchor.sequence, createdBy: userId });
        sessionId = fork.session.id;
        sequence = anchor.sequence + 1;
      } else sessionId = null; // Empty local history has no Turn to fork: create an independent root.
    }
    if (!sessionId) {
      sessionId = input.branchSessionId;
      const [collision] = await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, sessionId));
      if (collision) conflict("Session identity already exists / 会话身份已存在");
      await tx.insert(spaceSessions).values({ id: sessionId, spaceId, userUuid: userId, source: NATIVE_SYNC_SOURCE, meta: addSessionParticipantMeta({}, userId) });
      await tx.insert(sessionTurnSegments).values({ sessionId, ordinal: 1, sourceSessionId: sessionId, fromSequence: 1, toSequence: null });
    }
    const userContent = sanitizeContentBlocksForPostgresJson(input.userContent);
    const userText = deriveMessagePreviewText({ content: userContent }) || null;
    const startedAt = new Date(input.startedAt);
    const userMessageId = messageId(input.turnId, -1);
    const meta = {
      source: NATIVE_SYNC_SOURCE, harness: input.harness, runtime: "local", actorUserId: userId, userMessageId,
      runtimeRecovery: { state: "executing", ownerUserId: userId },
      nativeSync: { version: 1, spaceId, requestDigest, nativeSessionId: input.nativeSessionId, parentTurnId: input.parentTurnId, observedAt: new Date().toISOString() },
    };
    await tx.insert(sessionTurns).values({ id: input.turnId, sessionId, userUuid: userId, sequence, status: "running", intent: "followup", userContent, userText, meta, startedAt });
    const [last] = await tx.select({ sequence: sessionMessages.sequence }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)).orderBy(desc(sessionMessages.sequence)).limit(1);
    await tx.insert(sessionMessages).values({ id: userMessageId, sessionId, turnId: input.turnId, role: "user", content: userContent, text: userText, sequence: (last?.sequence ?? 0) + 1, idempotencyKey: `native:${input.turnId}:user`, meta: { ...meta, turnId: input.turnId, messageKind: "user" }, startedAt, completedAt: startedAt });
    const [before] = await tx.select({ meta: spaceSessions.meta }).from(spaceSessions).where(eq(spaceSessions.id, sessionId));
    const [session] = await tx.update(spaceSessions).set({
      meta: sanitizePostgresJsonValue(addSessionParticipantMeta(before?.meta, userId)),
      title: sql`coalesce(${spaceSessions.title}, ${deriveSessionFallbackTitle({ content: userContent })})`,
      latestMessageText: userText, lastMessageId: userMessageId, lastMessageAt: new Date(), updatedAt: new Date(),
    }).where(eq(spaceSessions.id, sessionId)).returning();
    if (!session) throw new Error("Failed to update native Session");
    const binding: NativeTurnBinding = { sessionId, turnId: input.turnId, forked: input.sessionId !== null && sessionId !== input.sessionId };
    return { binding, session, created: true, fork };
  });
}

export async function getOwnedNativeTurn(spaceId: string, userId: string, sessionId: string, turnId: string) {
  const [row] = await db.select({ turn: sessionTurns }).from(sessionTurns).innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(eq(spaceSessions.spaceId, spaceId), eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.id, turnId))).limit(1);
  if (!row) throw new NativeTurnError(404, "Turn not found / Turn 不存在");
  if (row.turn.userUuid !== userId || !isNativeClientTurn(row.turn.meta) || record(record(row.turn.meta).nativeSync).spaceId !== spaceId) throw new NativeTurnError(403, "Native Turn owner mismatch / 原生 Turn 所有者不匹配");
  return row.turn;
}

/** Completion, messages and terminal state commit atomically; object-storage artifacts retry separately. */
export async function completeNativeTurn(spaceId: string, userId: string, sessionId: string, turnId: string, input: NativeTurnComplete) {
  await getOwnedNativeTurn(spaceId, userId, sessionId, turnId);
  const completionDigest = digest(input);
  const committed = await db.transaction(async (tx) => {
    await tx.select({ id: spaceSessions.id }).from(spaceSessions).where(eq(spaceSessions.id, sessionId)).for("update");
    const [turn] = await tx.select().from(sessionTurns).where(eq(sessionTurns.id, turnId)).for("update");
    if (!turn) throw new NativeTurnError(404, "Turn not found / Turn 不存在");
    const meta = record(turn.meta), receipt = record(meta.nativeSync);
    if (record(meta.runtimeRecovery).state === "confirmed_stopped") conflict("Execution was resolved; retain the local receipt / 执行已确认停止，请保留本地回执");
    if (receipt.completionDigest && receipt.completionDigest !== completionDigest) conflict("Turn result is immutable / Turn 结果不可覆盖");
    if (terminal.has(turn.status)) {
      // Replay of the exact same completion: only the artifact snapshot may still be missing.
      if (receipt.completionDigest !== completionDigest) conflict("Turn already finalized / Turn 已结束");
      return { changed: false, turn, messages: [] };
    }
    const completedAt = new Date(input.completedAt);
    const messages = input.messages.map((message, ordinal): typeof sessionMessages.$inferSelect => {
      const final = ordinal === input.messages.length - 1;
      const content = sanitizeContentBlocksForPostgresJson(message.content);
      return {
        id: messageId(turnId, ordinal), sessionId, turnId, role: "assistant", content, text: deriveMessagePreviewText({ content }) || null,
        sequence: ordinal, idempotencyKey: `native:${turnId}:${ordinal}`, provider: message.provider ?? null, model: message.model ?? null,
        stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ? sanitizePostgresJsonValue(message.errorMessage) : null, usage: message.usage ?? null,
        meta: { turnId, messageOrdinal: ordinal, harness: record(turn.meta).harness, runtime: "local", source: NATIVE_SYNC_SOURCE, actorUserId: userId, anchorUserMessageId: record(turn.meta).userMessageId, messageKind: final ? input.status === "completed" ? "assistant_final" : "assistant_error" : "assistant_intermediate" },
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
      meta: { ...meta, runtimeArchiveStatus: "pending", nativeSync: { ...receipt, completionDigest } },
    }).where(and(eq(sessionTurns.id, turnId), runtimeResolutionOpen, inArray(sessionTurns.status, ["running", "abort_requested"]))).returning();
    if (!next) conflict("Execution was resolved / 执行已确认停止");
    await tx.update(spaceSessions).set({ latestMessageText: final?.text ?? turn.userText, ...(final ? { lastMessageId: final.id } : {}), lastMessageAt: new Date(), updatedAt: new Date() }).where(eq(spaceSessions.id, sessionId));
    return { changed: true, turn: next, messages };
  });
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
