import { UPLOAD_RATE_MAX_BYTES, UPLOAD_RATE_MAX_FILES, UPLOAD_RATE_WINDOW_SECONDS } from "@cohub/protocol";
import type { redisCommandClient } from "./redis.js";

/**
 * Fixed-window per-user quota shared by every durable upload path — space
 * files, public files, chat/app attachments and gateway attachments. They are
 * the same action staged under different object-key prefixes, so they draw
 * from one budget instead of per-feature rate limits.
 */
const CONSUME_UPLOAD_QUOTA_SCRIPT = `
local over = 0
if tonumber(ARGV[1]) > 0 then
  local next_files = redis.call("INCRBY", KEYS[1], ARGV[1])
  if next_files == tonumber(ARGV[1]) then redis.call("EXPIRE", KEYS[1], ARGV[5]) end
  if next_files > tonumber(ARGV[3]) then over = 1 end
end
if tonumber(ARGV[2]) > 0 then
  local next_bytes = redis.call("INCRBY", KEYS[2], ARGV[2])
  if next_bytes == tonumber(ARGV[2]) then redis.call("EXPIRE", KEYS[2], ARGV[5]) end
  if next_bytes > tonumber(ARGV[4]) then over = 1 end
end
if over == 0 then return {1, 0} end
if tonumber(ARGV[1]) > 0 then redis.call("DECRBY", KEYS[1], ARGV[1]) end
if tonumber(ARGV[2]) > 0 then redis.call("DECRBY", KEYS[2], ARGV[2]) end
local retry = redis.call("TTL", KEYS[1])
local retry_bytes = redis.call("TTL", KEYS[2])
if retry < 1 or (retry_bytes > 0 and retry_bytes < retry) then retry = retry_bytes end
if retry < 1 then retry = tonumber(ARGV[5]) end
return {0, retry}
`;

export class UploadRateLimitError extends Error {
  override name = "UploadRateLimitError";
  constructor(
    public readonly retryAfterSeconds: number,
    message = "too many uploads, please try again later",
  ) {
    super(message);
  }
}

export type UploadQuotaRedis = Pick<typeof redisCommandClient, "eval">;

/** Atomically charge one upload action against the per-user window. */
export const consumeUploadQuota = async (
  redis: UploadQuotaRedis,
  userId: string,
  usage: { entryCount?: number; totalBytes?: number } = {},
) => {
  const entryCount = Math.max(0, Math.floor(usage.entryCount ?? 0));
  const totalBytes = Math.max(0, Math.floor(usage.totalBytes ?? 0));
  if (entryCount === 0 && totalBytes === 0) return;
  const result = await redis.eval(
    CONSUME_UPLOAD_QUOTA_SCRIPT,
    2,
    `upload:rate:${userId}:files`,
    `upload:rate:${userId}:bytes`,
    entryCount,
    totalBytes,
    UPLOAD_RATE_MAX_FILES,
    UPLOAD_RATE_MAX_BYTES,
    UPLOAD_RATE_WINDOW_SECONDS,
  ) as [number, number];
  if (result[0] !== 1) throw new UploadRateLimitError(Math.max(1, result[1]));
};
