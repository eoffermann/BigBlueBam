import { describe, expect, it } from 'vitest';
import { takeSliceLock } from '../src/services/compile-ai.service.js';
import { RELEASE_IF_OWNER_LUA, redisSliceLock, type SliceLockRedis } from '../src/lib/slice-lock.js';

/** A tiny Redis: SET PX NX and the compare-and-delete script, or every call failing. */
function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis: SliceLockRedis & { store: Map<string, string> } = {
    store,
    async set(key, value) {
      if (opts.down) throw new Error('ECONNREFUSED');
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async eval(script, _n, key, token) {
      if (opts.down) throw new Error('ECONNREFUSED');
      expect(script).toBe(RELEASE_IF_OWNER_LUA);
      if (store.get(key!) === token) {
        store.delete(key!);
        return 1;
      }
      return 0;
    },
  };
  return redis;
}

const log = { lines: [] as string[], warn(_o: object, m?: string) { if (m) this.lines.push(m); } };

describe('slice lock (#242)', () => {
  it('a slice that outlived its TTL cannot delete the next slice lock (compare-and-delete)', async () => {
    const redis = fakeRedis();
    const lock = redisSliceLock(redis);
    const a = await lock.acquire('run-1', 1000);
    expect(a).toBeTruthy();
    expect(await lock.acquire('run-1', 1000)).toBeNull();
    // A's TTL lapses; B takes the lock.
    redis.store.delete('bastion:compile:slice:run-1');
    const b = await lock.acquire('run-1', 1000);
    expect(b).toBeTruthy();
    // A finally finishes and releases with its own (stale) token: B keeps the lock.
    await lock.release('run-1', a!);
    expect(redis.store.get('bastion:compile:slice:run-1')).toBe(b);
    await lock.release('run-1', b!);
    expect(redis.store.has('bastion:compile:slice:run-1')).toBe(false);
  });

  it('a Redis error is never "acquired": acquire throws and the caller falls back to the Postgres fence', async () => {
    const lock = redisSliceLock(fakeRedis({ down: true }));
    await expect(lock.acquire('run-1', 1000)).rejects.toThrow('ECONNREFUSED');
    expect(await takeSliceLock(lock, 'run-1', 1000, log)).toBe('unavailable');
    expect(log.lines.some((l) => l.includes('slice_token alone fences'))).toBe(true);
    // Held elsewhere is a plain null (report the slice running), not 'unavailable'.
    const up = redisSliceLock(fakeRedis());
    await up.acquire('run-2', 1000);
    expect(await takeSliceLock(up, 'run-2', 1000, log)).toBeNull();
  });
});
