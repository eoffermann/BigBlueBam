import { describe, expect, it } from 'vitest';
import { countThisMinute, type CounterRedis, peekThisMinute, secondsToNextMinute } from '../src/lib/feed-rate.js';

// The feed-push counters (#214, #225): INCR + EXPIRE NX in one MULTI, and fail open (null / 0,
// with a warning) when Redis is down instead of throwing an untyped 500.

function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Map<string, number>();
  const ttl = new Map<string, number>();
  const redis: CounterRedis = {
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        incr(key: string) {
          ops.push(() => {
            const n = (store.get(key) ?? 0) + 1;
            store.set(key, n);
            return [null, n];
          });
          return chain;
        },
        expire(key: string, seconds: number, mode: 'NX') {
          ops.push(() => {
            if (mode === 'NX' && ttl.has(key)) return [null, 0];
            ttl.set(key, seconds);
            return [null, 1];
          });
          return chain;
        },
        async exec() {
          if (opts.down) throw new Error('connect ECONNREFUSED');
          return ops.map((op) => op());
        },
      };
      return chain;
    },
    async get(key: string) {
      if (opts.down) throw new Error('connect ECONNREFUSED');
      const v = store.get(key);
      return v === undefined ? null : String(v);
    },
  };
  return { redis, store, ttl };
}

const log = () => {
  const lines: string[] = [];
  return { lines, warn: (_o: Record<string, unknown>, m: string) => void lines.push(m) };
};

describe('feed push counters', () => {
  const now = Date.UTC(2026, 10, 26, 12, 0, 30);

  it('counts per minute and sets a TTL once, in one round-trip', async () => {
    const { redis, ttl } = fakeRedis();
    const l = log();
    expect(await countThisMinute(redis, 'p', 'k', l, now)).toBe(1);
    expect(await countThisMinute(redis, 'p', 'k', l, now)).toBe(2);
    expect(await peekThisMinute(redis, 'p', 'k', l, now)).toBe(2);
    expect([...ttl.values()]).toEqual([70]);
    // The next minute starts a fresh counter.
    expect(await countThisMinute(redis, 'p', 'k', l, now + 60_000)).toBe(1);
    expect(l.lines).toEqual([]);
  });

  it('fails open with a warning when Redis is down (#225)', async () => {
    const { redis } = fakeRedis({ down: true });
    const l = log();
    await expect(countThisMinute(redis, 'p', 'k', l, now)).resolves.toBeNull();
    await expect(peekThisMinute(redis, 'p', 'k', l, now)).resolves.toBe(0);
    expect(l.lines).toHaveLength(2);
    expect(l.lines[0]).toContain('failing open');
  });

  it('Retry-After is the seconds left in the minute', () => {
    expect(secondsToNextMinute(now)).toBe(30);
  });
});
