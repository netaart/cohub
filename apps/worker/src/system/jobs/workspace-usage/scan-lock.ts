import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

// Not env-scoped: environments that share a Redis usually share the NAS too.
const LOCK_KEY = "cohub:{workspace-usage}:scan-lock";
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

type LockRedis = Pick<Redis, "set" | "eval">;

/**
 * Deployment-wide guard around the pdu process itself. BullMQ's global
 * concurrency counts active jobs, and a worker that loses its job lock keeps
 * its child running while the job is redelivered. The lease is not renewed:
 * it outlives the scan's hard deadline, which pdu enforces on itself (see
 * runPdu), so it cannot expire while a scan from a paused or dead holder runs.
 */
export async function acquireScanLock(redis: LockRedis, ttlMs: number) {
  const token = randomUUID();
  if (await redis.set(LOCK_KEY, token, "PX", ttlMs, "NX") !== "OK") return null;
  return {
    release: () => redis.eval(RELEASE, 1, LOCK_KEY, token).then(() => undefined, () => undefined),
  };
}
