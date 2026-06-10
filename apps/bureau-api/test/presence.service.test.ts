// Workstream 15 — unit tests for Bureau presence.service (§7 Redis keyspace).
//
// We mock ioredis with a small in-memory store that implements only the
// subset of commands this service uses: HSET/HGETALL/HMGET/HDEL, SADD/SREM/
// SMEMBERS, EXPIRE/EXISTS/TTL/DEL, plus a pipeline shim that queues calls
// and resolves them in order. The tests assert: keyspace shape, TTL refresh
// on every mutating call, atomic enterRoom (old occupants set is cleared
// before the new one is touched), and idempotent endSession.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createSession,
  heartbeat,
  endSession,
  enterRoom,
  leaveRoom,
  setFloor,
  setStatus,
  setDoor,
  lockRoom,
  getDoorState,
  getRoomOccupants,
  getFloorIndex,
  getSession,
  getUserSessions,
  keys,
  SESSION_TTL_SECONDS,
} from '../src/services/presence.service.js';

// ─────────────────────────────────────────────────────────────────────
// In-memory ioredis mock — only what presence.service.ts touches.
// ─────────────────────────────────────────────────────────────────────

interface MockEntry {
  // For HASH keys.
  hash?: Map<string, string>;
  // For SET keys.
  set?: Set<string>;
  // TTL in seconds; -1 = no ttl, -2 = missing (we delete the entry then).
  ttl?: number;
}

class MockRedis {
  store = new Map<string, MockEntry>();
  // Tracks calls in order so tests can assert pipelining semantics.
  calls: Array<[string, ...unknown[]]> = [];

  private ensureHash(key: string): Map<string, string> {
    let entry = this.store.get(key);
    if (!entry) {
      entry = { hash: new Map() };
      this.store.set(key, entry);
    }
    if (!entry.hash) entry.hash = new Map();
    return entry.hash;
  }
  private ensureSet(key: string): Set<string> {
    let entry = this.store.get(key);
    if (!entry) {
      entry = { set: new Set() };
      this.store.set(key, entry);
    }
    if (!entry.set) entry.set = new Set();
    return entry.set;
  }

  async hset(key: string, ...args: unknown[]): Promise<number> {
    this.calls.push(['hset', key, ...args]);
    const hash = this.ensureHash(key);
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) {
        hash.set(k, String(v));
      }
      return Object.keys(args[0] as object).length;
    }
    for (let i = 0; i < args.length; i += 2) {
      hash.set(String(args[i]), String(args[i + 1]));
    }
    return args.length / 2;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.calls.push(['hgetall', key]);
    const entry = this.store.get(key);
    if (!entry?.hash) return {};
    return Object.fromEntries(entry.hash);
  }

  async hget(key: string, field: string): Promise<string | null> {
    this.calls.push(['hget', key, field]);
    const entry = this.store.get(key);
    return entry?.hash?.get(field) ?? null;
  }

  async hdel(key: string, field: string): Promise<number> {
    this.calls.push(['hdel', key, field]);
    const entry = this.store.get(key);
    if (!entry?.hash) return 0;
    return entry.hash.delete(field) ? 1 : 0;
  }

  async sadd(key: string, member: string): Promise<number> {
    this.calls.push(['sadd', key, member]);
    const set = this.ensureSet(key);
    const had = set.has(member);
    set.add(member);
    return had ? 0 : 1;
  }

  async srem(key: string, member: string): Promise<number> {
    this.calls.push(['srem', key, member]);
    const entry = this.store.get(key);
    if (!entry?.set) return 0;
    return entry.set.delete(member) ? 1 : 0;
  }

  async smembers(key: string): Promise<string[]> {
    this.calls.push(['smembers', key]);
    const entry = this.store.get(key);
    return entry?.set ? Array.from(entry.set) : [];
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.calls.push(['expire', key, seconds]);
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.ttl = seconds;
    return 1;
  }

  async exists(key: string): Promise<number> {
    this.calls.push(['exists', key]);
    return this.store.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    this.calls.push(['del', key]);
    return this.store.delete(key) ? 1 : 0;
  }

  pipeline() {
    const queued: Array<() => Promise<unknown>> = [];
    const proxy: any = {};
    const wrap = (method: string) => {
      proxy[method] = (...a: unknown[]) => {
        queued.push(() => (this as any)[method](...a));
        return proxy;
      };
    };
    for (const m of ['hset', 'hgetall', 'hget', 'hdel', 'sadd', 'srem', 'smembers', 'expire', 'exists', 'del']) {
      wrap(m);
    }
    proxy.exec = async () => {
      const out: Array<[Error | null, unknown]> = [];
      for (const fn of queued) {
        try {
          const v = await fn();
          out.push([null, v]);
        } catch (e) {
          out.push([e as Error, null]);
        }
      }
      return out;
    };
    return proxy;
  }
}

function makeRedis() {
  return new MockRedis();
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('presence.service — createSession', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('writes the session HASH, joins the user set, and stamps the 35s TTL', async () => {
    await createSession(redis as any, {
      sessionId: 'sess-1',
      userId: 'user-1',
      isAgent: false,
      orgId: 'org-1',
      floorId: 'floor-1',
      device: 'web',
    });

    const session = await getSession(redis as any, 'sess-1');
    expect(session).not.toBeNull();
    expect(session?.userId).toBe('user-1');
    expect(session?.floorId).toBe('floor-1');
    expect(session?.roomId).toBeNull();
    expect(session?.status).toBe('available');

    const sessKey = keys.session('sess-1');
    expect(redis.store.get(sessKey)?.ttl).toBe(SESSION_TTL_SECONDS);

    const sessions = await getUserSessions(redis as any, 'user-1');
    expect(sessions).toContain('sess-1');
  });

  it('defaults floorId to null when not provided', async () => {
    await createSession(redis as any, {
      sessionId: 'sess-2',
      userId: 'user-2',
      isAgent: false,
      orgId: 'org-1',
      device: 'web',
    });
    const s = await getSession(redis as any, 'sess-2');
    expect(s?.floorId).toBeNull();
  });
});

describe('presence.service — heartbeat', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('returns false for an unknown sessionId and writes nothing', async () => {
    const ok = await heartbeat(redis as any, 'never-existed');
    expect(ok).toBe(false);
    expect(redis.store.has(keys.session('never-existed'))).toBe(false);
  });

  it('refreshes the TTL and bumps lastBeat on a live session', async () => {
    await createSession(redis as any, {
      sessionId: 's',
      userId: 'u',
      isAgent: false,
      orgId: 'o',
      device: 'web',
    });
    // Forge a low TTL so we can verify expire bumped it back up.
    redis.store.get(keys.session('s'))!.ttl = 1;

    const before = (await getSession(redis as any, 's'))?.lastBeat ?? 0;
    await new Promise((r) => setTimeout(r, 2));
    const ok = await heartbeat(redis as any, 's');
    expect(ok).toBe(true);
    expect(redis.store.get(keys.session('s'))!.ttl).toBe(SESSION_TTL_SECONDS);

    const after = (await getSession(redis as any, 's'))?.lastBeat ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('presence.service — enterRoom / leaveRoom', () => {
  let redis: MockRedis;
  beforeEach(async () => {
    redis = makeRedis();
    await createSession(redis as any, {
      sessionId: 's1',
      userId: 'u1',
      isAgent: false,
      orgId: 'org-1',
      floorId: 'floor-1',
      device: 'web',
    });
  });

  it('atomically moves a user from one room to another', async () => {
    const a = await enterRoom(redis as any, 's1', 'room-A');
    expect(a.previousRoomId).toBeNull();
    expect(a.floorId).toBe('floor-1');
    expect(await getRoomOccupants(redis as any, 'room-A')).toContain('u1');

    const b = await enterRoom(redis as any, 's1', 'room-B');
    expect(b.previousRoomId).toBe('room-A');
    expect(await getRoomOccupants(redis as any, 'room-A')).not.toContain('u1');
    expect(await getRoomOccupants(redis as any, 'room-B')).toContain('u1');

    const floorIndex = await getFloorIndex(redis as any, 'floor-1');
    expect(floorIndex.get('u1')).toBe('room-B');
  });

  it('does not srem when entering the same room twice', async () => {
    await enterRoom(redis as any, 's1', 'room-A');
    redis.calls = [];
    await enterRoom(redis as any, 's1', 'room-A');
    const srems = redis.calls.filter((c) => c[0] === 'srem');
    expect(srems.length).toBe(0);
  });

  it('refreshes the TTL on every room move', async () => {
    redis.store.get(keys.session('s1'))!.ttl = 1;
    await enterRoom(redis as any, 's1', 'room-A');
    expect(redis.store.get(keys.session('s1'))!.ttl).toBe(SESSION_TTL_SECONDS);
  });

  it('leaveRoom clears occupancy + floor index and bumps TTL', async () => {
    await enterRoom(redis as any, 's1', 'room-A');
    redis.store.get(keys.session('s1'))!.ttl = 1;
    const r = await leaveRoom(redis as any, 's1');
    expect(r.previousRoomId).toBe('room-A');
    expect(await getRoomOccupants(redis as any, 'room-A')).not.toContain('u1');
    expect((await getFloorIndex(redis as any, 'floor-1')).has('u1')).toBe(false);
    expect(redis.store.get(keys.session('s1'))!.ttl).toBe(SESSION_TTL_SECONDS);
    const s = await getSession(redis as any, 's1');
    expect(s?.roomId).toBeNull();
  });

  it('enterRoom throws when the session has lapsed', async () => {
    await expect(enterRoom(redis as any, 'bogus', 'room-X')).rejects.toThrow(/does not exist/);
  });
});

describe('presence.service — endSession', () => {
  let redis: MockRedis;
  beforeEach(() => {
    redis = makeRedis();
  });

  it('removes the session, occupants entry, and floor-index entry', async () => {
    await createSession(redis as any, {
      sessionId: 's',
      userId: 'u',
      isAgent: false,
      orgId: 'org-1',
      floorId: 'floor-1',
      device: 'web',
    });
    await enterRoom(redis as any, 's', 'room-1');

    const result = await endSession(redis as any, 's');
    expect(result).toEqual({
      userId: 'u',
      roomId: 'room-1',
      floorId: 'floor-1',
    });
    expect(redis.store.has(keys.session('s'))).toBe(false);
    expect(await getRoomOccupants(redis as any, 'room-1')).not.toContain('u');
    expect((await getFloorIndex(redis as any, 'floor-1')).has('u')).toBe(false);
    const sessions = await getUserSessions(redis as any, 'u');
    expect(sessions).not.toContain('s');
  });

  it('returns null when the session is already gone (idempotent)', async () => {
    const result = await endSession(redis as any, 'gone');
    expect(result).toBeNull();
  });
});

describe('presence.service — setStatus / setDoor / lockRoom', () => {
  let redis: MockRedis;
  beforeEach(async () => {
    redis = makeRedis();
    await createSession(redis as any, {
      sessionId: 's',
      userId: 'u',
      isAgent: false,
      orgId: 'org-1',
      device: 'web',
    });
  });

  it('setStatus writes status/statusText/emoji and refreshes TTL', async () => {
    redis.store.get(keys.session('s'))!.ttl = 1;
    await setStatus(redis as any, 's', 'dnd', 'In flow', ':do_not_disturb:');
    const session = await getSession(redis as any, 's');
    expect(session?.status).toBe('dnd');
    expect(session?.statusText).toBe('In flow');
    expect(session?.emoji).toBe(':do_not_disturb:');
    expect(redis.store.get(keys.session('s'))!.ttl).toBe(SESSION_TTL_SECONDS);
  });

  it('setDoor records privacy + lockedBy on the room state HASH (no TTL)', async () => {
    await setDoor(redis as any, 'room-X', 'private', 'u-owner');
    const stateKey = keys.roomState('room-X');
    const hash = await redis.hgetall(stateKey);
    expect(hash.privacy).toBe('private');
    expect(hash.lockedBy).toBe('u-owner');
    // No TTL written for room-state.
    expect(redis.store.get(stateKey)?.ttl).toBeUndefined();
  });

  it('lockRoom is sugar over setDoor(privacy=private)', async () => {
    await lockRoom(redis as any, 'room-Y', 'u-owner');
    const hash = await redis.hgetall(keys.roomState('room-Y'));
    expect(hash.privacy).toBe('private');
    expect(hash.lockedBy).toBe('u-owner');
  });

  it('getDoorState round-trips setDoor and returns null when unset', async () => {
    expect(await getDoorState(redis as any, 'room-untouched')).toBeNull();
    await setDoor(redis as any, 'room-Z', 'private', 'u-owner');
    expect(await getDoorState(redis as any, 'room-Z')).toEqual({
      privacy: 'private',
      lockedBy: 'u-owner',
    });
    await setDoor(redis as any, 'room-Z', 'open', null);
    expect(await getDoorState(redis as any, 'room-Z')).toEqual({
      privacy: 'open',
      lockedBy: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Reaper index (bureau:presence:index) — the TTL-less snapshot that lets
// the worker reaper clean up sessions whose TTL'd hash Redis already
// evicted. Without it a crashed client ghosts in its room forever.
// ─────────────────────────────────────────────────────────────────────

function readIndexEntry(redis: MockRedis, sessionId: string) {
  const raw = redis.store.get(keys.sessionIndex())?.hash?.get(sessionId);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('presence.service — reaper session index', () => {
  let redis: MockRedis;
  beforeEach(async () => {
    redis = makeRedis();
    await createSession(redis as any, {
      sessionId: 's-idx',
      userId: 'u-idx',
      isAgent: false,
      orgId: 'org-1',
      floorId: 'floor-1',
      device: 'web',
    });
  });

  it('createSession writes a TTL-less index entry', () => {
    expect(readIndexEntry(redis, 's-idx')).toEqual({
      userId: 'u-idx',
      orgId: 'org-1',
      floorId: 'floor-1',
      roomId: null,
      device: 'web',
    });
    // The index HASH itself must never carry a TTL.
    expect(redis.store.get(keys.sessionIndex())?.ttl).toBeUndefined();
  });

  it('enterRoom / leaveRoom keep the index roomId in sync', async () => {
    await enterRoom(redis as any, 's-idx', 'room-A');
    expect(readIndexEntry(redis, 's-idx')?.roomId).toBe('room-A');

    await leaveRoom(redis as any, 's-idx');
    expect(readIndexEntry(redis, 's-idx')?.roomId).toBeNull();
  });

  it('enterRoom with an explicit floor updates the index floorId', async () => {
    await enterRoom(redis as any, 's-idx', 'room-B', 'floor-2');
    const entry = readIndexEntry(redis, 's-idx');
    expect(entry?.roomId).toBe('room-B');
    expect(entry?.floorId).toBe('floor-2');
  });

  it('setFloor mirrors the floor onto the index', async () => {
    await setFloor(redis as any, 's-idx', 'floor-9');
    expect(readIndexEntry(redis, 's-idx')?.floorId).toBe('floor-9');
  });

  it('endSession removes the index entry', async () => {
    await endSession(redis as any, 's-idx');
    expect(readIndexEntry(redis, 's-idx')).toBeNull();
  });

  it('index survives session-hash eviction (the reaper recovery case)', async () => {
    await enterRoom(redis as any, 's-idx', 'room-A');
    // Simulate Redis evicting the TTL'd hash on lapse.
    redis.store.delete(keys.session('s-idx'));
    const entry = readIndexEntry(redis, 's-idx');
    expect(entry).toEqual({
      userId: 'u-idx',
      orgId: 'org-1',
      floorId: 'floor-1',
      roomId: 'room-A',
      device: 'web',
    });
  });
});
