import { redisCommandClient } from "../redis.js";

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const ACQUIRE_SCRIPT = `
local current = redis.call("get", KEYS[1])
if not current or current == ARGV[1] then
  redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
return 0
`;

const LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Serialize saves per space. `owner` is the task run, so a run retried after
 * its worker died takes its own lock back instead of waiting for it to expire.
 */
export async function withSpaceSaveLock<T>(spaceId: string, owner: string, fn: () => Promise<T>): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const key = `cohub:space:${spaceId}:save-checkpoint`;
  const acquired = await redisCommandClient.eval(ACQUIRE_SCRIPT, 1, key, owner, String(LOCK_TTL_MS));
  if (acquired !== 1) return { acquired: false };

  const heartbeat = setInterval(() => {
    void redisCommandClient.eval(EXTEND_SCRIPT, 1, key, owner, String(LOCK_TTL_MS)).catch(() => undefined);
  }, Math.floor(LOCK_TTL_MS / 4));
  heartbeat.unref?.();

  try {
    return { acquired: true, result: await fn() };
  } finally {
    clearInterval(heartbeat);
    await redisCommandClient.eval(RELEASE_SCRIPT, 1, key, owner).catch(() => undefined);
  }
}
