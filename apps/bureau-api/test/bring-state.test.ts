// Bureau "Bring" (follow-the-leader) live-state unit tests.
//
// The headline regression this file guards: a Bring must survive a follower's
// cross-app navigation (a full page reload that closes + reopens the WS). The
// fix keys the follow relationship on TTL'd Redis leases that the heartbeat
// re-extends, and reconciles the leader's follower SET on every read so a
// member whose pointer has lapsed (closed tab) or repointed (now follows
// someone else) is dropped instead of being fanned navigation forever.
//
// These tests exercise the value-based reconciliation + the target round-trip
// against a minimal in-memory Redis. (TTL expiry itself is a Redis primitive;
// we simulate a lapsed lease by deleting the pointer the way an expiry would.)

import { describe, it, expect, beforeEach } from 'vitest';

import {
  startFollow,
  stopFollow,
  getFollowers,
  getLeader,
  endLeaderBrings,
  setBringTarget,
  getBringTarget,
  touchBring,
  isBringLeaderAlive,
} from '../src/lib/bring-state.js';

// ─────────────────────────────────────────────────────────────────────
// Minimal ioredis mock: string + set commands, EX/EXPIRE/EXISTS, and a
// pipeline that records get/del/expire ops and replays them on exec().
// ─────────────────────────────────────────────────────────────────────

class MockPipeline {
  ops: Array<['get' | 'del' | 'expire', string]> = [];
  constructor(private redis: MockRedis) {}
  get(key: string) {
    this.ops.push(['get', key]);
    return this;
  }
  del(key: string) {
    this.ops.push(['del', key]);
    return this;
  }
  expire(key: string, _ttl: number) {
    this.ops.push(['expire', key]);
    return this;
  }
  async exec(): Promise<Array<[Error | null, unknown]>> {
    return this.ops.map(([cmd, key]) => {
      if (cmd === 'get') return [null, this.redis.strings.get(key) ?? null];
      if (cmd === 'del') {
        const had = this.redis.strings.delete(key) || this.redis.sets.delete(key);
        return [null, had ? 1 : 0];
      }
      // expire: no-op in the mock (TTL has no clock here) but report success
      // when the key exists, matching ioredis' 1/0 return.
      const exists = this.redis.strings.has(key) || this.redis.sets.has(key);
      return [null, exists ? 1 : 0];
    });
  }
}

class MockRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added++;
      set.add(m);
    }
    this.sets.set(key, set);
    return added;
  }
  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async set(key: string, value: string, _ex?: string, _ttl?: number): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    const had = this.strings.delete(key) || this.sets.delete(key);
    return had ? 1 : 0;
  }
  async expire(key: string, _ttl: number): Promise<number> {
    return this.strings.has(key) || this.sets.has(key) ? 1 : 0;
  }
  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sets.has(key) ? 1 : 0;
  }
  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the mock implements only the subset of the ioredis surface bring-state uses.
const asRedis = (m: MockRedis) => m as any;

const ORG = 'org-1';
const LEADER = 'leader-1';

describe('bring-state', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = new MockRedis();
  });

  it('startFollow registers the follow and reports a live count', async () => {
    const count = await startFollow(asRedis(redis), ORG, LEADER, 'f1');
    expect(count).toBe(1);
    expect(await getFollowers(asRedis(redis), ORG, LEADER)).toEqual(['f1']);
    expect(await getLeader(asRedis(redis), ORG, 'f1')).toBe(LEADER);
  });

  it('getFollowers reconciles a member whose lease lapsed (closed tab)', async () => {
    await startFollow(asRedis(redis), ORG, LEADER, 'f1');
    await startFollow(asRedis(redis), ORG, LEADER, 'f2');
    // Simulate f2's follower pointer expiring (TTL lapse on a closed tab):
    // the SET still lists f2, but the pointer is gone.
    redis.strings.delete(`bureau:bring:follower:${ORG}:f2`);

    const live = await getFollowers(asRedis(redis), ORG, LEADER);
    expect(live).toEqual(['f1']);
    // The stale member is pruned from the set so it isn't re-checked forever.
    expect(await redis.smembers(`bureau:bring:leader:${ORG}:${LEADER}`)).toEqual(['f1']);
  });

  it('getFollowers drops a member who repointed to another leader', async () => {
    await startFollow(asRedis(redis), ORG, LEADER, 'f1');
    // f1 now follows a different leader — its pointer no longer matches.
    await startFollow(asRedis(redis), ORG, 'leader-2', 'f1');

    const live = await getFollowers(asRedis(redis), ORG, LEADER);
    expect(live).toEqual([]);
    expect(await getFollowers(asRedis(redis), ORG, 'leader-2')).toEqual(['f1']);
  });

  it('stopFollow removes membership and only clears a pointer it still owns', async () => {
    await startFollow(asRedis(redis), ORG, LEADER, 'f1');
    await startFollow(asRedis(redis), ORG, LEADER, 'f2');

    const remaining = await stopFollow(asRedis(redis), ORG, LEADER, 'f1');
    expect(remaining).toBe(1);
    expect(await getLeader(asRedis(redis), ORG, 'f1')).toBeNull();
    expect(await getLeader(asRedis(redis), ORG, 'f2')).toBe(LEADER);
  });

  it('endLeaderBrings clears followers, the set, and the resume target', async () => {
    await startFollow(asRedis(redis), ORG, LEADER, 'f1');
    await startFollow(asRedis(redis), ORG, LEADER, 'f2');
    await setBringTarget(asRedis(redis), ORG, LEADER, {
      url: 'https://x/b3/board?task=1',
      app: 'b3',
      leaderName: 'Lead',
    });

    const ended = await endLeaderBrings(asRedis(redis), ORG, LEADER);
    expect(ended.sort()).toEqual(['f1', 'f2']);
    expect(await getFollowers(asRedis(redis), ORG, LEADER)).toEqual([]);
    expect(await getLeader(asRedis(redis), ORG, 'f1')).toBeNull();
    expect(await getBringTarget(asRedis(redis), ORG, LEADER)).toBeNull();
  });

  it('target round-trips and drives leader-alive detection', async () => {
    expect(await isBringLeaderAlive(asRedis(redis), ORG, LEADER)).toBe(false);
    await setBringTarget(asRedis(redis), ORG, LEADER, {
      url: 'https://x/b3/board?task=42',
      app: 'b3',
      label: '/b3/board',
      leaderName: 'Lead',
    });
    expect(await getBringTarget(asRedis(redis), ORG, LEADER)).toEqual({
      url: 'https://x/b3/board?task=42',
      app: 'b3',
      label: '/b3/board',
      leaderName: 'Lead',
    });
    expect(await isBringLeaderAlive(asRedis(redis), ORG, LEADER)).toBe(true);
  });

  it('touchBring is a no-op-safe refresh for non-participants', async () => {
    await expect(touchBring(asRedis(redis), ORG, 'nobody')).resolves.toBeUndefined();
  });
});
