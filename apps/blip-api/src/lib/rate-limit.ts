/**
 * Redis token-bucket rate limiter for the Blip ingest edge (Blip §11.1).
 * Evaluated before any body parse. Two tiers both must pass: per-key and
 * per-tracked-app. Atomic via a small Lua script so concurrent requests can't
 * over-spend the bucket.
 */
import type Redis from 'ioredis';

// KEYS[1] = bucket key; ARGV[1] = refill_per_sec, ARGV[2] = burst,
// ARGV[3] = now_ms, ARGV[4] = cost. Returns {allowed(0/1), retry_after_ms}.
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local refill = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = burst; ts = now end
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(burst, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / refill) * 1000)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil((burst / refill) * 1000) + 1000)
return {allowed, retry}
`;

export type BucketParams = { refill_per_sec: number; burst: number };

export type RateResult = { allowed: boolean; retryAfterMs: number };

export async function consumeToken(
  redis: Redis,
  bucketKey: string,
  params: BucketParams,
  nowMs: number,
  cost = 1,
): Promise<RateResult> {
  try {
    const res = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      bucketKey,
      String(params.refill_per_sec),
      String(params.burst),
      String(nowMs),
      String(cost),
    )) as [number, number];
    return { allowed: res[0] === 1, retryAfterMs: res[1] };
  } catch {
    // Fail-open on Redis trouble: telemetry intake should degrade to accepting
    // rather than dropping when the limiter itself is unavailable.
    return { allowed: true, retryAfterMs: 0 };
  }
}
