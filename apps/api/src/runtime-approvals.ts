import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import {
  RUNTIME_APPROVAL_CHANNEL,
  runtimeApprovalSchema,
  runtimeApprovalsKey,
  type ApprovalDecision,
  type RuntimeApproval,
  type SessionApproval,
} from "@cohub/protocol";
import { db } from "./db/index.js";
import { redisCommandClient } from "./redis.js";
import { dispatchRealtimeEvent } from "./channels.js";

export class ApprovalError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422) { super(message); }
}

/** Invalidation only; clients read the pending list. */
async function publishChanged(spaceId: string, sessionId: string) {
  await dispatchRealtimeEvent({ id: randomUUID(), timestamp: Date.now(), domain: "space", type: "space.session.approvals.changed", spaceId, sessionId, payload: { sessionId } });
}

/** Only a running Turn of this Space's Session may ask. */
export async function openRuntimeApproval(spaceId: string, sessionId: string, turnId: string, approval: RuntimeApproval) {
  const [turn] = await db.select({ status: sessionTurns.status }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(eq(sessionTurns.id, turnId), eq(sessionTurns.sessionId, sessionId), eq(spaceSessions.spaceId, spaceId)))
    .limit(1);
  if (!turn || !["running", "abort_requested"].includes(turn.status)) throw new ApprovalError("Turn is not running", 409);
  const key = runtimeApprovalsKey(spaceId, sessionId);
  await redisCommandClient.multi()
    .hset(key, approval.id, JSON.stringify({ ...approval, turnId } satisfies SessionApproval))
    // The Runtime gives up at `expiresAt`; the key outlives each entry briefly and reads drop expired ones.
    .pexpire(key, Math.max(Date.parse(approval.expiresAt) - Date.now(), 0) + 60_000)
    .exec();
  void publishChanged(spaceId, sessionId).catch(() => undefined);
  return { accepted: true };
}

export async function closeRuntimeApproval(spaceId: string, sessionId: string, approvalId: string) {
  const removed = await redisCommandClient.hdel(runtimeApprovalsKey(spaceId, sessionId), approvalId);
  if (removed) void publishChanged(spaceId, sessionId).catch(() => undefined);
  return { accepted: true };
}

function parse(raw: string): SessionApproval | null {
  try {
    const { turnId, ...value } = JSON.parse(raw) as { turnId?: unknown };
    const approval = runtimeApprovalSchema.safeParse(value);
    return approval.success && typeof turnId === "string" && Date.parse(approval.data.expiresAt) > Date.now()
      ? { ...approval.data, turnId }
      : null;
  } catch { return null; }
}

export async function listRuntimeApprovals(spaceId: string, sessionId: string): Promise<SessionApproval[]> {
  const entries = await redisCommandClient.hgetall(runtimeApprovalsKey(spaceId, sessionId));
  return Object.values(entries).flatMap((raw) => parse(raw) ?? []).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** The first decision wins; it reaches the Runtime through whichever Gateway holds its connection. */
export async function decideRuntimeApproval(spaceId: string, sessionId: string, approvalId: string, decision: ApprovalDecision) {
  const key = runtimeApprovalsKey(spaceId, sessionId);
  const raw = await redisCommandClient.hget(key, approvalId);
  const approval = raw ? parse(raw) : null;
  if (!approval) throw new ApprovalError("This approval is no longer pending", 404);
  if (!approval.decisions.includes(decision)) throw new ApprovalError("This decision is not offered", 422);
  if (await redisCommandClient.hdel(key, approvalId) !== 1) throw new ApprovalError("This approval was already decided", 409);
  await redisCommandClient.publish(RUNTIME_APPROVAL_CHANNEL, JSON.stringify({
    type: "runtime.approval.decision", spaceId, sessionId, turnId: approval.turnId, approvalId, decision,
  }));
  void publishChanged(spaceId, sessionId).catch(() => undefined);
}
