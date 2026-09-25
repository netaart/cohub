import { and, eq, sql } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { readRuntimeRecovery, runtimeRecoveryActive } from "@cohub/core/sessions";
import { resolveHarness, type LocalHarness, type RuntimeRecoveryState } from "@cohub/protocol";
import type { AgentRuntimeRecoveryJobData } from "@cohub/infra/agent-queue";
import { db } from "../db.js";
import { acquireSessionLock, type SessionLock } from "../session-lock.js";
import { persistAssistantMessage, persistBatchUserMessages, publishSessionTurnsUpdated } from "../persistence.js";
import { enqueueAgentTurnJob } from "../queue.js";
import { loadClaimedTurnBatch } from "../batch.js";
import { logger } from "../logger.js";
import { RuntimeResultUnavailableError } from "./exchange.js";
import { executeRemoteHarnessTurn, markRuntimeRecovery } from "./remote-runtime.js";

const turnMeta = (turn: { meta: unknown }) => turn.meta as Record<string, unknown> | null;
const turnUserMessageId = (turn: { id: string; meta: unknown }) => {
  const meta = turnMeta(turn);
  return String(meta?.userMessageId ?? meta?.messageId ?? turn.id);
};

/** A confirmed stop is terminal: record the resolution and never read late native results. */
async function recordConfirmedStop(input: { spaceId: string; turn: typeof sessionTurns.$inferSelect; harness: LocalHarness; recovery: RuntimeRecoveryState | null; confirmedBy?: string; lock: SessionLock }): Promise<boolean> {
  const { turn, lock } = input;
  lock.signal.throwIfAborted();
  const resolution = input.recovery?.state === "confirmed_stopped"
    ? input.recovery
    : { ...input.recovery, state: "confirmed_stopped" as const, resolvedBy: input.confirmedBy, resolvedAt: new Date().toISOString() };
  const [confirmed] = await db.update(sessionTurns).set({ meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || ${JSON.stringify({ runtimeRecovery: resolution })}::jsonb` })
    .where(and(eq(sessionTurns.id, turn.id), runtimeRecoveryActive)).returning({ id: sessionTurns.id });
  if (!confirmed) return false;
  const userMessageId = turnUserMessageId(turn);
  const batch = await loadClaimedTurnBatch({ ...turn, intent: turn.intent ?? "followup" });
  await persistBatchUserMessages({ spaceId: input.spaceId, sessionId: turn.sessionId, batch });
  lock.signal.throwIfAborted();
  await persistAssistantMessage({ spaceId: input.spaceId, spaceSessionId: turn.sessionId, turnId: turn.id, userMessageId, userId: turn.userUuid,
    idempotencyKey: `runtime-resolution:${turn.id}`, messageOrdinal: 100_000,
    event: { message: { role: "assistant", content: [{ type: "system_note", note_type: "info", text: "Runtime stopped by confirmation; prior effects remain unknown. Do not replay." }], stopReason: "aborted", meta: { runtime: "local", harness: input.harness, runtimeResolution: true, messageKind: "assistant_final" } } },
  });
  return true;
}

/** Reconnect a disconnected host: `turn.recover` only replays a saved result, never new work. */
async function recoverOrphanTurn(input: { spaceId: string; turn: typeof sessionTurns.$inferSelect; harness: LocalHarness; lock: SessionLock }): Promise<"recovered" | "attention" | "retry"> {
  const { turn, lock } = input;
  try {
    const batch = await loadClaimedTurnBatch({ ...turn, intent: turn.intent ?? "followup" });
    const meta = turnMeta(turn);
    const context = meta?.context && typeof meta.context === "object" && !Array.isArray(meta.context)
      ? meta.context as Record<string, unknown>
      : null;
    const requestId = typeof context?.requestId === "string" ? context.requestId : null;
    await executeRemoteHarnessTurn({ spaceId: input.spaceId, sessionId: turn.sessionId, batch, actorUserId: turn.userUuid, harness: input.harness, accessMode: "read_only", recovery: true, requestId, abortSignal: lock.signal, leaseSignal: lock.signal });
    return "recovered";
  } catch (error) {
    if (!(error instanceof RuntimeResultUnavailableError)) {
      logger.debug("[Runtime] automatic reconciliation will retry", { spaceId: input.spaceId, turnId: turn.id, error });
      return "retry";
    }
    const recovery = readRuntimeRecovery(turn.meta);
    if (!lock.signal.aborted && recovery?.state !== "attention") {
      await markRuntimeRecovery(turn.id, { state: "attention", ownerUserId: recovery?.ownerUserId });
      await publishSessionTurnsUpdated({ sessionId: turn.sessionId, turnIds: [turn.id] });
    }
    logger.debug("[Runtime] automatic reconciliation will retry", { spaceId: input.spaceId, turnId: turn.id, error });
    return "attention";
  }
}

/** Reconcile one Session as a unit; the turn identity only fences the original execution. */
export async function recoverRuntime(input: AgentRuntimeRecoveryJobData) {
  const [session] = await db.select({ id: spaceSessions.id }).from(spaceSessions)
    .where(and(eq(spaceSessions.id, input.sessionId), eq(spaceSessions.spaceId, input.spaceId))).limit(1);
  if (!session) throw new Error("Runtime recovery Session does not belong to Space");

  const lock = await acquireSessionLock(input.sessionId);
  if (!lock) throw new Error("Runtime recovery is waiting for the Session lock");
  let drain = false;
  try {
    const [turn] = await db.select().from(sessionTurns).where(and(
      eq(sessionTurns.id, input.expectedTurnId),
      eq(sessionTurns.sessionId, input.sessionId),
      runtimeRecoveryActive,
    )).limit(1);
    if (!turn) return { recovered: 0, attention: 0 };

    const harness = resolveHarness(turn.meta);
    const recovery = readRuntimeRecovery(turn.meta);
    if (harness !== input.expectedHarness || recovery?.ownerUserId !== input.expectedOwnerUserId) {
      throw new Error("Runtime recovery execution identity changed");
    }

    const confirmedBy = input.confirmation && recovery.state === "attention" ? input.confirmation.actorUserId : undefined;
    if (confirmedBy || recovery.state === "confirmed_stopped") {
      if (await recordConfirmedStop({ spaceId: input.spaceId, turn, harness, recovery, confirmedBy, lock })) drain = true;
      return { recovered: drain ? 1 : 0, attention: 0 };
    }

    const outcome = await recoverOrphanTurn({ spaceId: input.spaceId, turn, harness, lock });
    if (outcome === "retry") throw new Error("Runtime recovery transport is unavailable");
    if (outcome === "recovered") drain = true;
    return { recovered: outcome === "recovered" ? 1 : 0, attention: outcome === "attention" ? 1 : 0 };
  } finally {
    await lock.release();
    if (drain) await enqueueAgentTurnJob({ spaceId: input.spaceId, sessionId: input.sessionId, reason: "drain" });
  }
}
