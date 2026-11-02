import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";

let status = "running";
const hashes = new Map<string, Map<string, string>>();
const published: Array<{ channel: string; message: unknown }> = [];
const realtime: unknown[] = [];
const hash = (key: string) => hashes.get(key) ?? hashes.set(key, new Map()).get(key) as Map<string, string>;
const redis = {
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      hset: (key: string, field: string, value: string) => { ops.push(() => hash(key).set(field, value)); return chain; },
      pexpire: () => chain,
      exec: async () => { for (const op of ops) op(); },
    };
    return chain;
  },
  hget: async (key: string, field: string) => hash(key).get(field) ?? null,
  hgetall: async (key: string) => Object.fromEntries(hash(key)),
  hdel: async (key: string, field: string) => hash(key).delete(field) ? 1 : 0,
  publish: async (channel: string, message: string) => { published.push({ channel, message: JSON.parse(message) }); return 1; },
};
const select = () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => status ? [{ status }] : [] }) }) }) });
mock.module("../src/db/index.js", { namedExports: { db: { select } } });
mock.module("../src/redis.js", { namedExports: { redisCommandClient: redis } });
mock.module("../src/channels.js", { namedExports: { dispatchRealtimeEvent: async (event: unknown) => { realtime.push(event); } } });
const { ApprovalError, closeRuntimeApproval, decideRuntimeApproval, listRuntimeApprovals, openRuntimeApproval } = await import("../src/runtime-approvals.js");

const spaceId = randomUUID(), sessionId = randomUUID(), turnId = randomUUID();
const approval = (patch: Record<string, unknown> = {}) => ({
  id: randomUUID(), kind: "command" as const, command: "touch x", decisions: ["accept" as const, "decline" as const],
  requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...patch,
});

test("a running Turn's approval is listed, decided once and relayed to the Runtime", async () => {
  const card = approval();
  await openRuntimeApproval(spaceId, sessionId, turnId, card);
  assert.deepEqual((await listRuntimeApprovals(spaceId, sessionId)).map((item) => [item.id, item.turnId]), [[card.id, turnId]]);
  await assert.rejects(decideRuntimeApproval(spaceId, sessionId, card.id, "accept_for_session"), (error: unknown) => error instanceof ApprovalError && error.status === 422);
  await decideRuntimeApproval(spaceId, sessionId, card.id, "accept");
  assert.deepEqual(published.at(-1)?.message, { type: "runtime.approval.decision", spaceId, sessionId, turnId, approvalId: card.id, decision: "accept" });
  await assert.rejects(decideRuntimeApproval(spaceId, sessionId, card.id, "decline"), (error: unknown) => error instanceof ApprovalError && error.status === 404);
  assert.deepEqual(await listRuntimeApprovals(spaceId, sessionId), []);
  await new Promise((resolve) => setImmediate(resolve));
  assert(realtime.length >= 2, "clients are told to refresh");
});

test("only running Turns ask; closed and expired cards disappear", async () => {
  status = "completed";
  await assert.rejects(openRuntimeApproval(spaceId, sessionId, turnId, approval()), (error: unknown) => error instanceof ApprovalError && error.status === 409);
  status = "running";
  const card = approval();
  await openRuntimeApproval(spaceId, sessionId, turnId, card);
  await closeRuntimeApproval(spaceId, sessionId, card.id);
  await openRuntimeApproval(spaceId, sessionId, turnId, approval({ expiresAt: new Date(Date.now() - 1).toISOString() }));
  assert.deepEqual(await listRuntimeApprovals(spaceId, sessionId), []);
});
