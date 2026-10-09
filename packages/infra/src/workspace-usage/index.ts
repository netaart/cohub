import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { WorkspaceUsage } from "@cohub/protocol";
import { createLogger } from "../logging/index.js";

const logger = createLogger({ serviceName: "cohub-infra" });

export type UsageRedis = Pick<Redis, "eval" | "hgetall">;

/** Stopped-workspace writes settle this long before a scan may start. */
export const USAGE_QUIET_MS = 5 * 60_000;
/** Minimum time between two scan attempts of one workspace. */
export const USAGE_MIN_SCAN_INTERVAL_MS = 48 * 60 * 60_000;
/**
 * Clean workspaces are measured again after this long, bounding how stale a
 * workspace stays when a write marker was lost to a Redis failure.
 */
export const USAGE_CLEAN_RECALIBRATION_MS = 30 * 24 * 60 * 60_000;

// Same Redis hash tag lets all state transitions run atomically on Redis Cluster.
export const usagePrefix = (env: string) => `cohub:{workspace-usage-${env}}`;
export const usageKey = (env: string, spaceId: string) => `${usagePrefix(env)}:space:${spaceId}`;
export const usageDueKey = (env: string) => `${usagePrefix(env)}:due`;

// KEYS: workspace hash, due set.
// ARGV: spaceId, revision, now, writer delta, running ("1", "0" or "" to keep), quiet ms, min scan interval ms.
export const MARK_USAGE_SCRIPT = `
local key, due = KEYS[1], KEYS[2]
local id, revision, now, delta, runtime = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
redis.call('HSET', key, 'revision', revision, 'dirty', '1')
local writers = math.max(0, tonumber(redis.call('HGET', key, 'writers') or '0') + delta)
redis.call('HSET', key, 'writers', writers)
if runtime ~= '' then redis.call('HSET', key, 'running', runtime) end
local nextAt = now
if redis.call('HGET', key, 'running') ~= '1' then nextAt = now + tonumber(ARGV[6]) end
local lastScan = tonumber(redis.call('HGET', key, 'lastScanAt') or redis.call('HGET', key, 'measuredAt') or '0')
if lastScan > 0 then
  nextAt = math.max(nextAt, lastScan + tonumber(ARGV[7]))
end
redis.call('HSET', key, 'notBeforeAt', nextAt)
redis.call('ZADD', due, nextAt, id)
return revision
`;

/** Called before and after a write batch. Never called once per filesystem event. */
export async function markWorkspaceUsage(redis: Pick<UsageRedis, "eval">, env: string, spaceId: string, delta = 0, running?: boolean) {
  return redis.eval(MARK_USAGE_SCRIPT, 2, usageKey(env, spaceId), usageDueKey(env),
    spaceId, randomUUID(), Date.now(), delta, running === undefined ? "" : running ? "1" : "0", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
}

/**
 * Marks a sandbox lifecycle transition. Inventory reconciles lifecycle state
 * from the database as well, so a failed marker only delays the next scan and
 * never fails the transition.
 */
export async function markWorkspaceRuntime(redis: Pick<UsageRedis, "eval">, env: string, spaceId: string, running: boolean) {
  await markWorkspaceUsage(redis, env, spaceId, 0, running).catch((error) => {
    logger.warn(`[WorkspaceUsage] lifecycle marker failed spaceId=${spaceId}`, error);
  });
}

/**
 * Runs a write that lands on the workspace volume directly. Usage is a
 * display estimate, so a Redis failure never blocks the write: a write whose
 * markers are both lost stays unmeasured until the workspace's next
 * lifecycle change or clean recalibration.
 */
export async function withWorkspaceUsageWrite<T>(redis: Pick<UsageRedis, "eval">, env: string, spaceId: string, write: () => Promise<T>): Promise<T> {
  const begun = await markWorkspaceUsage(redis, env, spaceId, 1).then(() => true, (error) => {
    logger.warn(`[WorkspaceUsage] write start marker failed spaceId=${spaceId}`, error);
    return false;
  });
  try {
    return await write();
  } finally {
    // Without a start marker there is no writer to release; still mark the change.
    await markWorkspaceUsage(redis, env, spaceId, begun ? -1 : 0).catch((error) => {
      logger.warn(`[WorkspaceUsage] write end marker failed spaceId=${spaceId}`, error);
    });
  }
}

// KEYS: workspace hash, due set.
// ARGV: spaceId, signature, running, now, revision, provider, quiet ms, min scan interval ms, clean recalibration ms.
export const RECONCILE_USAGE_SCRIPT = `
local key, due = KEYS[1], KEYS[2]
local id, signature, running, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
if ARGV[6] == 'local' then
  redis.call('DEL', key)
  redis.call('ZREM', due, id)
  return 0
end
local changed = redis.call('HGET', key, 'signature') ~= signature or redis.call('HGET', key, 'running') ~= running
if changed then
  redis.call('HSET', key, 'signature', signature, 'running', running, 'dirty', '1', 'revision', ARGV[5])
  local lastScan = tonumber(redis.call('HGET', key, 'lastScanAt') or redis.call('HGET', key, 'measuredAt') or '0')
  local nextAt = math.max(now + tonumber(ARGV[7]), lastScan + tonumber(ARGV[8]))
  redis.call('HSET', key, 'notBeforeAt', nextAt)
  redis.call('ZADD', due, nextAt, id)
elseif not redis.call('ZSCORE', due, id) then
  local lastScan = tonumber(redis.call('HGET', key, 'lastScanAt') or redis.call('HGET', key, 'measuredAt') or '0')
  if lastScan == 0 or redis.call('HGET', key, 'dirty') == '1' or running == '1' or now >= lastScan + tonumber(ARGV[9]) then
    local nextAt = math.max(now, lastScan + tonumber(ARGV[8]))
    redis.call('HSET', key, 'notBeforeAt', nextAt)
    redis.call('ZADD', due, nextAt, id)
  end
end
return 1
`;

export type UsageSandbox = {
  provider: string;
  status: string;
  podName: string | null;
  stoppedAt: Date | null;
  meta: unknown;
};
export function workspaceRuntime(sandbox: UsageSandbox | null) {
  const meta = sandbox?.meta && typeof sandbox.meta === "object" ? sandbox.meta as Record<string, unknown> : {};
  return {
    provider: sandbox?.provider ?? "cloud",
    running: Boolean(sandbox && !["stopped", "terminated"].includes(sandbox.status)),
    signature: JSON.stringify([sandbox?.provider, sandbox?.status, sandbox?.podName, sandbox?.stoppedAt,
      meta.resumeStartedAt, meta.startedAt, meta.provisioningStartedAt, meta.lastRecoveryStartedAt]),
  };
}

export function reconcileUsageArgs(env: string, spaceId: string, sandbox: UsageSandbox | null) {
  const runtime = workspaceRuntime(sandbox);
  return [usageKey(env, spaceId), usageDueKey(env), spaceId, runtime.signature, runtime.running ? "1" : "0",
    Date.now(), randomUUID(), runtime.provider, USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_CLEAN_RECALIBRATION_MS] as const;
}

export function parseWorkspaceUsage(raw: Record<string, string>): WorkspaceUsage {
  const bytes = Number(raw.bytes);
  const at = Number(raw.measuredAt);
  const valid = /^\d+$/.test(raw.bytes ?? "") && /^\d+$/.test(raw.measuredAt ?? "") && Number.isSafeInteger(bytes) && bytes >= 0
    && Number.isSafeInteger(at) && at > 0 && at <= 8.64e15;
  return {
    bytes: valid ? bytes : null,
    measuredAt: valid ? new Date(at).toISOString() : null,
    status: raw.error ? "error" : !valid ? "pending" : raw.dirty === "1" || raw.running === "1" ? "stale" : "ready",
  };
}

export async function getWorkspaceUsage(redis: Pick<UsageRedis, "hgetall">, env: string, spaceId: string) {
  return parseWorkspaceUsage(await redis.hgetall(usageKey(env, spaceId)));
}
