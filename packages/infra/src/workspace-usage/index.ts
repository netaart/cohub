import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { WorkspaceUsage } from "@cohub/protocol";

export type UsageRedis = Pick<Redis, "eval" | "hgetall" | "zrangebyscore" | "get" | "set" | "pipeline">;
const QUIET_MS = 5 * 60_000;
export const USAGE_MIN_SCAN_INTERVAL_MS = 48 * 60 * 60_000;
// Same Redis hash tag lets all state transitions run atomically on Redis Cluster.
export const usagePrefix = (env: string) => `cohub:{workspace-usage-${env}}`;
export const usageKey = (env: string, spaceId: string) => `${usagePrefix(env)}:space:${spaceId}`;
export const usageDueKey = (env: string) => `${usagePrefix(env)}:due`;

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
  nextAt = math.max(nextAt, lastScan + tonumber(redis.call('HGET', key, 'minScanIntervalMs') or '172800000'))
end
redis.call('HSET', key, 'notBeforeAt', nextAt)
redis.call('ZADD', due, nextAt, id)
return revision
`;

/** Called before and after a write batch. Never called once per filesystem event. */
export async function markWorkspaceUsage(redis: Pick<UsageRedis, "eval">, env: string, spaceId: string, delta = 0, running?: boolean) {
  return redis.eval(MARK_USAGE_SCRIPT, 2, usageKey(env, spaceId), usageDueKey(env),
    spaceId, randomUUID(), Date.now(), delta, running === undefined ? "" : running ? "1" : "0", QUIET_MS);
}

export async function withWorkspaceUsageWrite<T>(redis: UsageRedis, env: string, spaceId: string, write: () => Promise<T>): Promise<T> {
  // If the marker cannot be recorded, fail before modifying files. Partial writes
  // and process crashes remain dirty; an orphan writer conservatively keeps scanning.
  await markWorkspaceUsage(redis, env, spaceId, 1);
  try {
    return await write();
  } finally {
    await markWorkspaceUsage(redis, env, spaceId, -1).catch((error) => {
      console.error("Workspace usage completion marker failed / 空间统计写入标记失败", error);
    });
  }
}

export const RECONCILE_USAGE_SCRIPT = `
local key, due = KEYS[1], KEYS[2]
local id, signature, running, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
if ARGV[6] == 'local' then
  redis.call('DEL', key)
  redis.call('ZREM', due, id)
  return 0
end
redis.call('HSET', key, 'minScanIntervalMs', ARGV[8])
local changed = redis.call('HGET', key, 'signature') ~= signature or redis.call('HGET', key, 'running') ~= running
if changed then
  redis.call('HSET', key, 'signature', signature, 'running', running, 'dirty', '1', 'revision', ARGV[5])
  local lastScan = tonumber(redis.call('HGET', key, 'lastScanAt') or redis.call('HGET', key, 'measuredAt') or '0')
  local nextAt = math.max(now + tonumber(ARGV[7]), lastScan + tonumber(ARGV[8]))
  redis.call('HSET', key, 'notBeforeAt', nextAt)
  redis.call('ZADD', due, nextAt, id)
elseif not redis.call('ZSCORE', due, id) then
  local lastScan = tonumber(redis.call('HGET', key, 'lastScanAt') or redis.call('HGET', key, 'measuredAt') or '0')
  if lastScan == 0 or redis.call('HGET', key, 'dirty') == '1' or running == '1' then
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

export function reconcileUsageArgs(env: string, spaceId: string, sandbox: UsageSandbox | null, minScanIntervalMs = USAGE_MIN_SCAN_INTERVAL_MS) {
  const runtime = workspaceRuntime(sandbox);
  return [usageKey(env, spaceId), usageDueKey(env), spaceId, runtime.signature, runtime.running ? "1" : "0",
    Date.now(), randomUUID(), runtime.provider, QUIET_MS, minScanIntervalMs] as const;
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

export async function getWorkspaceUsages(redis: UsageRedis, env: string, ids: string[]) {
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(usageKey(env, id));
  const results = await pipeline.exec();
  return new Map(ids.map((id, i) => {
    const entry = results?.[i];
    return [id, parseWorkspaceUsage(entry && !entry[0] ? entry[1] as Record<string, string> : {})];
  }));
}
