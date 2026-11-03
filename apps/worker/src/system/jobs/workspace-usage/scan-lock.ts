import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

// Not env-scoped: environments that share a Redis usually share the NAS too.
// Slot 0 keeps the single-lock key so older workers still count during a rollout.
const LOCK_KEY = "cohub:{workspace-usage}:scan-lock";
const slotKey = (slot: number) => (slot === 0 ? LOCK_KEY : `${LOCK_KEY}:${slot}`);
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

type LockRedis = Pick<Redis, "set" | "eval">;

/**
 * Deployment-wide cap on concurrent pdu processes, one key per slot. BullMQ's global
 * concurrency counts active jobs, and a worker that loses its job lock keeps
 * its child running while the job is redelivered. The lease is not renewed:
 * it outlives the scan's hard deadline, which pdu enforces on itself (see
 * runPdu), so it cannot expire while a scan from a paused or dead holder runs.
 */
export async function acquireScanLock(redis: LockRedis, ttlMs: number, slots: number) {
  const token = randomUUID();
  for (let slot = 0; slot < slots; slot++) {
    const key = slotKey(slot);
    if (await redis.set(key, token, "PX", ttlMs, "NX") !== "OK") continue;
    return {
      release: () => redis.eval(RELEASE, 1, key, token).then(() => undefined, () => undefined),
    };
  }
  return null;
}
