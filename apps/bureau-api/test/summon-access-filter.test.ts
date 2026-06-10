// Workstream 15 — planSummon access-filter unit tests.
//
// Verifies:
//   - recipients without cross-app access are split out of `eligibleRecipients`
//     and into `deniedRecipients` with outcome='no_access'.
//   - the summoner is never enumerated as a recipient (§10 step 2).
//   - returns null when the summoner has no live session in a room.
//   - canShare reflects the summoner's own resolveAccess result.
//   - both eligible AND denied lists are stamped onto the audit row in
//     recordSummon (verifies the audit contract from §10 step 3).
//
// We mock cross-app-access.resolveAccess so we can control the decision per
// recipient, mock the drizzle db chain for resolveDisplayNames + the audit
// insert in recordSummon, and use the small in-memory MockRedis from
// presence.service.test.ts (duplicated here to keep test files self-contained).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── env / db / cross-app-access mocks BEFORE the SUT import ──────────

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    BBB_API_INTERNAL_URL: 'http://api',
    BOARD_INTERNAL_URL: 'http://board',
    BRIEF_INTERNAL_URL: 'http://brief',
    BOOK_INTERNAL_URL: 'http://book',
    BOLT_API_INTERNAL_URL: 'http://bolt',
    MCP_INTERNAL_URL: 'http://mcp',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    LIVEKIT_URL: 'ws://localhost:7880',
    BBB_PERMISSIONS_ENFORCE: 'off',
  },
}));

// Drizzle chains used in summon.service: select().from().where().limit() and
// insert().values().returning(). We expose mock fns so each test can set the
// row that comes back. vi.hoisted keeps these references usable inside the
// vi.mock factory (which is itself hoisted to the top of the file).
const { selectLimit, insertReturning, updateWhere } = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  insertReturning: vi.fn(),
  updateWhere: vi.fn(),
}));
vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: selectLimit }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: insertReturning }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: updateWhere }),
    }),
  },
  connection: { end: vi.fn() },
}));

// Per-recipient decision is what we want to control.
const { resolveAccessMock } = vi.hoisted(() => ({ resolveAccessMock: vi.fn() }));
vi.mock('../src/services/cross-app-access.service.js', () => ({
  resolveAccess: (...args: unknown[]) => resolveAccessMock(...args),
}));

// Bolt event emission is fire-and-forget — stub it so the test does not
// need a live Bolt API.
vi.mock('../src/lib/bureau-events.js', () => ({
  emitSummonIssued: vi.fn().mockResolvedValue(undefined),
}));

// Mock publishUserTarget so reportDenials doesn't try to hit a real channel.
vi.mock('../src/services/presence-publisher.service.js', () => ({
  publishUserTarget: vi.fn().mockResolvedValue(undefined),
}));

// BullMQ Queue is only constructed when offload kicks in; we keep
// recipients well under FANOUT_INLINE_LIMIT to avoid that branch entirely.
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn() })),
}));

// ─── In-memory Redis (subset used by summon.service) ─────────────────

class MockRedis {
  store = new Map<string, { hash?: Map<string, string>; set?: Set<string> }>();

  async smembers(key: string): Promise<string[]> {
    const e = this.store.get(key);
    return e?.set ? Array.from(e.set) : [];
  }
  async sadd(key: string, member: string): Promise<number> {
    let e = this.store.get(key);
    if (!e) {
      e = { set: new Set() };
      this.store.set(key, e);
    }
    if (!e.set) e.set = new Set();
    const had = e.set.has(member);
    e.set.add(member);
    return had ? 0 : 1;
  }
  async hset(key: string, ...args: unknown[]): Promise<number> {
    let e = this.store.get(key);
    if (!e) {
      e = { hash: new Map() };
      this.store.set(key, e);
    }
    if (!e.hash) e.hash = new Map();
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) {
        e.hash.set(k, String(v));
      }
    } else {
      for (let i = 0; i < args.length; i += 2) {
        e.hash.set(String(args[i]), String(args[i + 1]));
      }
    }
    return 1;
  }
  async hmget(key: string, ...fields: string[]): Promise<Array<string | null>> {
    const e = this.store.get(key);
    if (!e?.hash) return fields.map(() => null);
    return fields.map((f) => e.hash!.get(f) ?? null);
  }
  async publish(_channel: string, _payload: string): Promise<number> {
    return 1;
  }
  pipeline() {
    const queued: Array<() => Promise<unknown>> = [];
    const p: any = {};
    for (const m of ['smembers', 'sadd', 'hset', 'hmget']) {
      p[m] = (...a: unknown[]) => {
        queued.push(() => (this as any)[m](...a));
        return p;
      };
    }
    p.exec = async () => {
      const out: Array<[Error | null, unknown]> = [];
      for (const fn of queued) {
        try {
          out.push([null, await fn()]);
        } catch (e) {
          out.push([e as Error, null]);
        }
      }
      return out;
    };
    return p;
  }
}

// Helper: stage a summoner + 2 recipients into the same room in Redis.
async function seedRoom(redis: MockRedis, opts: {
  summonerId: string;
  recipients: string[];
  roomId: string;
}) {
  // user sessions for summoner.
  await redis.sadd(`bureau:user:${opts.summonerId}:sessions`, 'sess-summoner');
  await redis.hset(`bureau:sess:sess-summoner`, {
    userId: opts.summonerId,
    roomId: opts.roomId,
    floorId: 'floor-1',
  });
  // occupants set includes summoner + every recipient.
  for (const uid of [opts.summonerId, ...opts.recipients]) {
    await redis.sadd(`bureau:room:${opts.roomId}:occupants`, uid);
  }
}

// ─── Import SUT after mocks. ─────────────────────────────────────────

import { planSummon, recordSummon, fanOutSummon } from '../src/services/summon.service.js';

// We program db.select(...).limit(...) to return different things depending
// on which call this is (user-name lookup vs. bureau_settings lookup).
function programDbSelectQueue(items: unknown[][]) {
  // Reset and re-prime: each call to .limit() pops the head of the queue.
  selectLimit.mockReset();
  for (const item of items) selectLimit.mockResolvedValueOnce(item);
  // Trailing fallback so unexpected extra calls don't throw with confusing
  // errors — they'll just see no row, which forces the SUT to a safe default.
  selectLimit.mockResolvedValue([]);
}

beforeEach(() => {
  resolveAccessMock.mockReset();
  selectLimit.mockReset();
  insertReturning.mockReset();
  updateWhere.mockReset();
});

describe('planSummon — recipient eligibility', () => {
  it('returns null when the summoner is not currently in any room', async () => {
    const redis = new MockRedis();
    // No user-sessions entry at all.
    const plan = await planSummon(redis as any, {
      orgId: 'org-1',
      summonerId: 'summ',
      targetUrl: 'https://example.com/x',
      targetApp: 'board',
    });
    expect(plan).toBeNull();
  });

  it('splits recipients into eligible and denied based on resolveAccess', async () => {
    const redis = new MockRedis();
    await seedRoom(redis, {
      summonerId: 'summ',
      recipients: ['alice', 'bob', 'charlie'],
      roomId: 'room-1',
    });

    // Summoner's own access (canShare probe), then per-recipient.
    resolveAccessMock
      .mockResolvedValueOnce({ allowed: true, canShare: true }) // summoner
      .mockResolvedValueOnce({ allowed: true, canShare: false }) // alice
      .mockResolvedValueOnce({ allowed: false, canShare: false, reason: 'private' }) // bob
      .mockResolvedValueOnce({ allowed: true, canShare: false }); // charlie

    // resolveDisplayNames: one select call per unique userId in
    // [summoner, ...recipients]. Order is deterministic from
    // [summonerId, ...recipientIds].
    programDbSelectQueue([
      [{ id: 'summ', name: 'Sam' }],
      [{ id: 'alice', name: 'Alice' }],
      [{ id: 'bob', name: 'Bob' }],
      [{ id: 'charlie', name: 'Charlie' }],
    ]);

    const plan = await planSummon(redis as any, {
      orgId: 'org-1',
      summonerId: 'summ',
      targetUrl: 'https://example.com/x',
      targetApp: 'board',
    });

    expect(plan).not.toBeNull();
    expect(plan!.fromRoomId).toBe('room-1');
    expect(plan!.canShare).toBe(true);
    // Eligible = alice + charlie.
    const eligibleIds = plan!.eligibleRecipients.map((r) => r.userId).sort();
    expect(eligibleIds).toEqual(['alice', 'charlie']);
    // Denied = bob, with no_access outcome AND the reason from the access service.
    expect(plan!.deniedRecipients).toHaveLength(1);
    expect(plan!.deniedRecipients[0].userId).toBe('bob');
    expect(plan!.deniedRecipients[0].outcome).toBe('no_access');
    expect(plan!.deniedRecipients[0].reason).toBe('private');
    // Summoner is never enumerated.
    expect(eligibleIds).not.toContain('summ');
    expect(plan!.deniedRecipients.map((r) => r.userId)).not.toContain('summ');
  });
});

describe('recordSummon — audit row contract', () => {
  it('writes eligible + denied recipients to the bureau_summons row', async () => {
    insertReturning.mockResolvedValueOnce([{ id: 'summon-uuid' }]);

    const id = await recordSummon({
      orgId: 'org-1',
      summonerId: 'summ',
      fromRoomId: 'room-1',
      targetUrl: 'https://example.com/x',
      targetApp: 'board',
      targetLabel: 'Roadmap Board',
      eligible: [
        { userId: 'alice', name: 'Alice', outcome: 'pending' },
      ],
      denied: [
        { userId: 'bob', name: 'Bob', outcome: 'no_access', reason: 'private' },
      ],
    });
    expect(id).toBe('summon-uuid');

    // Inspect what was passed to .values(). The mock chain we set up means
    // db.insert(...) returns an object whose .values is a vi.fn(), so we
    // can read its first call's argument.
    const db = (await import('../src/db/index.js')).db as any;
    const valuesArg = db.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(valuesArg.recipients).toEqual([
      { userId: 'alice', name: 'Alice', outcome: 'pending' },
      { userId: 'bob', name: 'Bob', outcome: 'no_access', reason: 'private' },
    ]);
    expect(valuesArg.org_id).toBe('org-1');
    expect(valuesArg.from_room_id).toBe('room-1');
    expect(valuesArg.target_app).toBe('board');
  });
});

describe('fanOutSummon — inline publishes to user channels', () => {
  it('publishes one summon_incoming per recipient', async () => {
    const redis = new MockRedis();
    const pubSpy = vi.spyOn(redis, 'publish');
    // bureau_settings select for shouldAutoFollow.
    programDbSelectQueue([[{ allow: false }]]);

    await fanOutSummon({
      redis: redis as any,
      summonId: 'summon-uuid',
      orgId: 'org-1',
      summonerId: 'summ',
      summonerName: 'Sam',
      targetUrl: 'https://example.com/x',
      targetApp: 'board',
      recipients: [
        { userId: 'alice', name: 'Alice', outcome: 'pending' },
        { userId: 'charlie', name: 'Charlie', outcome: 'pending' },
      ],
    });

    expect(pubSpy).toHaveBeenCalledTimes(2);
    const channels = pubSpy.mock.calls.map((c) => c[0]);
    expect(channels).toContain('user:alice');
    expect(channels).toContain('user:charlie');
    // Verify the payload shape is what the SDK expects.
    const payload = JSON.parse(pubSpy.mock.calls[0][1] as string);
    expect(payload.type).toBe('summon_incoming');
    expect(payload.data.summonId).toBe('summon-uuid');
    expect(payload.data.summoner.id).toBe('summ');
  });
});
