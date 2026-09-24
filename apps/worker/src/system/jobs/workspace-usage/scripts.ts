// KEYS: workspace hash, due set, global scan slots. Tokens fence stale workers.
export const CLAIM_SCAN = `
local now = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local lease = tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0')
if lease > now then return {'busy'} end
local lastScan = tonumber(redis.call('HGET', KEYS[1], 'lastScanAt') or redis.call('HGET', KEYS[1], 'measuredAt') or '0')
local cooldownUntil = 0
if lastScan > 0 then cooldownUntil = lastScan + tonumber(redis.call('HGET', KEYS[1], 'minScanIntervalMs') or ARGV[6]) end
local notBefore = tonumber(redis.call('HGET', KEYS[1], 'notBeforeAt') or '0')
local nextAt = math.max(cooldownUntil, notBefore)
if nextAt > now then
  redis.call('ZADD', KEYS[2], nextAt, ARGV[1])
  return {'cooldown', tostring(nextAt)}
end
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[5]) then return {'busy'} end
redis.call('HSETNX', KEYS[1], 'revision', ARGV[2])
redis.call('HSET', KEYS[1], 'scanToken', ARGV[2], 'leaseUntil', now + tonumber(ARGV[4]), 'lastScanAt', now)
redis.call('HDEL', KEYS[1], 'notBeforeAt')
redis.call('ZADD', KEYS[3], now + tonumber(ARGV[4]), ARGV[2])
return {'claimed', redis.call('HGET', KEYS[1], 'revision')}
`;
export const RENEW_SCAN = `
if redis.call('HGET', KEYS[1], 'scanToken') ~= ARGV[1] then return 0 end
local score = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[1]) or '0')
if score <= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], 'leaseUntil', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;
export const FINISH_SCAN = `
if redis.call('HGET', KEYS[1], 'scanToken') ~= ARGV[2] then return 0 end
local score = tonumber(redis.call('ZSCORE', KEYS[3], ARGV[2]) or '0')
if score <= tonumber(ARGV[4]) then return 0 end
redis.call('ZREM', KEYS[3], ARGV[2])
redis.call('HDEL', KEYS[1], 'scanToken', 'leaseUntil')
local now = tonumber(ARGV[4])
if ARGV[6] ~= '' then
  local failures = redis.call('HINCRBY', KEYS[1], 'failures', 1)
  redis.call('HSET', KEYS[1], 'error', ARGV[6], 'dirty', '1')
  local lastScan = tonumber(redis.call('HGET', KEYS[1], 'lastScanAt') or now)
  local retryAt = now + math.min(21600000, 300000 * 2 ^ math.min(failures - 1, 7))
  local nextAt = math.max(retryAt, lastScan + tonumber(ARGV[7]))
  redis.call('HSET', KEYS[1], 'notBeforeAt', nextAt)
  redis.call('ZADD', KEYS[2], nextAt, ARGV[1])
  return 1
end
redis.call('HSET', KEYS[1], 'bytes', ARGV[5], 'measuredAt', now, 'failures', '0')
redis.call('HDEL', KEYS[1], 'error')
local changed = redis.call('HGET', KEYS[1], 'revision') ~= ARGV[3]
local running = redis.call('HGET', KEYS[1], 'running') == '1'
local writers = tonumber(redis.call('HGET', KEYS[1], 'writers') or '0')
if not changed and not running and writers == 0 then
  redis.call('HSET', KEYS[1], 'dirty', '0')
  redis.call('HDEL', KEYS[1], 'notBeforeAt')
  redis.call('ZREM', KEYS[2], ARGV[1])
else
  redis.call('HSET', KEYS[1], 'dirty', '1')
  local lastScan = tonumber(redis.call('HGET', KEYS[1], 'lastScanAt') or now)
  local nextAt = lastScan + tonumber(ARGV[7])
  if not running then nextAt = math.max(now + tonumber(ARGV[8]), nextAt) end
  redis.call('HSET', KEYS[1], 'notBeforeAt', nextAt)
  redis.call('ZADD', KEYS[2], nextAt, ARGV[1])
end
return 1
`;
// A bounded pending window prevents thousands of delayed scans competing with
// ordinary system jobs. Expiry repairs dispatcher/worker crashes and lost queues.
export const RESERVE_DUE = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local capacity = math.max(0, tonumber(ARGV[2]) - redis.call('ZCARD', KEYS[2]))
if capacity == 0 then return {} end
local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]) * 2)
local ids = {}
for _, id in ipairs(candidates) do
  if #ids >= capacity then break end
  if not redis.call('ZSCORE', KEYS[2], id) then
    redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + 300000, id)
    redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + 600000, id)
    table.insert(ids, id)
  end
end
return ids
`;
