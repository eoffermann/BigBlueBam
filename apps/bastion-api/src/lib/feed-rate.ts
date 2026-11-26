// Per-minute counters for the machine feed push (spec 3.5), shared by every bastion-api instance
// through Redis.
//
//   per key   60 batches a minute per authenticated feed key (BASTION_FEED_KEY_RATE_PER_MINUTE).
//   per IP    failed authentications a minute from one address; past the ceiling the address is
//             refused before its body is parsed or any key is looked up (#214).
//
// Redis down: fail open with a warning (#225). The per-feed daily quota lives in Postgres and still
// bounds the volume, and the route-level per-IP limiter still runs, so an outage of the counter
// store never turns into an ingest outage or an untyped 500.

/** The slice of ioredis these counters use (a fake in tests). */
export interface CounterPipeline {
  incr(key: string): CounterPipeline;
  expire(key: string, seconds: number, mode: 'NX'): CounterPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface CounterRedis {
  multi(): CounterPipeline;
  get(key: string): Promise<string | null>;
}

export interface CounterLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Failed feed authentications one IP may make per minute before it is refused outright. */
export const BASTION_FEED_AUTH_FAILURES_PER_IP_MINUTE = 20;
/** Feed pushes one IP may make per minute (route-level, before the body is parsed). */
export const BASTION_FEED_PUSHES_PER_IP_MINUTE = 240;

const minuteOf = (nowMs: number) => Math.floor(nowMs / 60_000);
export const secondsToNextMinute = (nowMs: number) => 60 - (Math.floor(nowMs / 1000) % 60);

/**
 * Count one hit this minute. INCR and EXPIRE NX go in one round-trip, so a crash between them can
 * never leave a key without a TTL. Returns null when Redis is unavailable (fail open).
 */
export async function countThisMinute(redis: CounterRedis, prefix: string, id: string, log: CounterLog, nowMs = Date.now()): Promise<number | null> {
  const key = `${prefix}:${id}:${minuteOf(nowMs)}`;
  try {
    const res = await redis.multi().incr(key).expire(key, 70, 'NX').exec();
    const first = res?.[0];
    if (!first || first[0]) throw first?.[0] ?? new Error('empty MULTI reply');
    return Number(first[1]);
  } catch (err) {
    log.warn({ counter: prefix, err: (err as Error).message }, 'bastion-feed-push: rate counter unavailable; failing open (the daily quota still applies)');
    return null;
  }
}

/** The current count this minute without incrementing. 0 when Redis is unavailable (fail open). */
export async function peekThisMinute(redis: CounterRedis, prefix: string, id: string, log: CounterLog, nowMs = Date.now()): Promise<number> {
  try {
    return Number((await redis.get(`${prefix}:${id}:${minuteOf(nowMs)}`)) ?? 0);
  } catch (err) {
    log.warn({ counter: prefix, err: (err as Error).message }, 'bastion-feed-push: rate counter unavailable; failing open (the daily quota still applies)');
    return 0;
  }
}

export const FEED_KEY_RATE_PREFIX = 'bastion:feed-rate';
export const FEED_AUTH_FAIL_PREFIX = 'bastion:feed-authfail';
