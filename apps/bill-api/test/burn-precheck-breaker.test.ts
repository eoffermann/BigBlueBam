import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the platform's FIRST circuit breaker
 * (apps/bill-api/src/lib/burn-precheck.client.ts, Burn spec 5.5.1).
 *
 * There is no in-tree precedent for this component, so these tests are the specification
 * of its behavior as much as its verification. The properties that matter:
 *
 *   1. The failure counter is a SHARED ATOMIC INCR, so N replicas each seeing one failure
 *      trip a threshold-N breaker. This is the single most important property; per-process
 *      counting would need threshold x replicas failures and would effectively never trip
 *      on a horizontally-scaled service.
 *   2. An open breaker short-circuits at ZERO NETWORK COST.
 *   3. The half-open probe is SINGLE-FLIGHT under an NX key, so a recovering burn-api is
 *      probed by one replica per interval rather than stampeded by all of them.
 *   4. EVERY Redis touch is non-throwing. Redis runs at --maxmemory noeviction, where
 *      writes error out at the cap; a throw here would propagate out of a Fastify
 *      preHandler and BLOCK AN EXPENSE WRITE.
 */

vi.mock('../src/db/index.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4014,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    PUBLIC_URL: 'http://localhost',
    COOKIE_SECURE: false,
    BURN_API_INTERNAL_URL: 'http://burn-api:4022',
    BURN_PRECHECK_TIMEOUT_MS: 800,
    BURN_PRECHECK_BREAKER_THRESHOLD: 5,
    BURN_PRECHECK_BREAKER_PROBE_MS: 30000,
    INTERNAL_SERVICE_SECRET: 'b'.repeat(32),
  },
}));

const ORG = '00000000-0000-0000-0000-0000000000aa';
const ORG_B = '00000000-0000-0000-0000-0000000000bb';

/**
 * A minimal in-memory Redis good enough for the key operations under test. Deliberately
 * NOT ioredis-mock: the point is to model the SHARED store that multiple simulated
 * replicas hit, so a single instance is passed to every "replica" in a test.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    store,
    calls,
    async incr(key: string) {
      calls.push(`incr ${key}`);
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
    async expire(key: string, _s: number) {
      calls.push(`expire ${key}`);
      return 1;
    },
    async get(key: string) {
      calls.push(`get ${key}`);
      return store.get(key) ?? null;
    },
    async del(...keys: string[]) {
      calls.push(`del ${keys.join(',')}`);
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
    async set(key: string, value: string, _mode: 'PX', _ttl: number, condition?: 'NX') {
      calls.push(`set ${key}${condition ? ' NX' : ''}`);
      if (condition === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  } as any;
}

/** A Redis whose every operation rejects. Models the noeviction cap and a full outage. */
function brokenRedis() {
  const boom = async () => {
    throw new Error('OOM command not allowed when used memory > maxmemory');
  };
  return { incr: boom, expire: boom, get: boom, del: boom, set: boom } as any;
}

const silentLogger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

async function mod() {
  return import('../src/lib/burn-precheck.client.js');
}

const config = {
  baseUrl: 'http://burn-api:4022',
  timeoutMs: 800,
  breakerThreshold: 5,
  breakerProbeMs: 30000,
  internalSecret: 'b'.repeat(32),
};

beforeEach(async () => {
  const { __resetFallbackBreakers } = await mod();
  __resetFallbackBreakers();
  silentLogger.warn.mockClear();
});

// ---------------------------------------------------------------------------

describe('burn breaker: key shapes', () => {
  it('uses the exact keys the spec names, per org', async () => {
    const m = await mod();
    expect(m.BREAKER_FAILS_KEY(ORG)).toBe(`burn:breaker:fails:${ORG}`);
    expect(m.BREAKER_STATE_KEY(ORG)).toBe(`burn:breaker:state:${ORG}`);
    expect(m.BREAKER_PROBE_KEY(ORG)).toBe(`burn:breaker:probe:${ORG}`);
    expect(m.GATE_CALLS_KEY(ORG, '20260719')).toBe(`burn:gate_calls:${ORG}:20260719`);
  });

  it('keeps the open-state TTL well above one probe interval', async () => {
    // If these were equal the state key would self-expire every interval and every replica
    // would go straight through, making the NX probe election decorative.
    const m = await mod();
    expect(m.OPEN_STATE_TTL_MULTIPLIER).toBeGreaterThan(1);
  });
});

describe('burn breaker: tripping', () => {
  it('stays closed below the threshold and opens exactly at it', async () => {
    const m = await mod();
    const redis = fakeRedis();
    const deps = { redis, config };

    for (let i = 1; i < config.breakerThreshold; i++) {
      const r = await m.recordBreakerFailure(deps, ORG);
      expect(r.opened).toBe(false);
      expect(r.fails).toBe(i);
      expect(redis.store.get(m.BREAKER_STATE_KEY(ORG))).toBeUndefined();
    }

    const tripping = await m.recordBreakerFailure(deps, ORG);
    expect(tripping.opened).toBe(true);
    expect(redis.store.get(m.BREAKER_STATE_KEY(ORG))).toBe('open');
    // The streak counter is cleared on trip so the next window starts fresh.
    expect(redis.store.get(m.BREAKER_FAILS_KEY(ORG))).toBeUndefined();
  });

  it('THE MULTI-REPLICA PROPERTY: 5 different replicas failing once each trips it', async () => {
    // This is the whole reason the counter lives in Redis rather than in a module-level
    // variable. Each iteration is a DIFFERENT bill-api process sharing one Redis.
    const m = await mod();
    const sharedRedis = fakeRedis();

    let opened = false;
    for (let replica = 0; replica < 5; replica++) {
      const r = await m.recordBreakerFailure({ redis: sharedRedis, config }, ORG);
      opened = opened || r.opened;
    }

    expect(opened).toBe(true);
    expect(sharedRedis.store.get(m.BREAKER_STATE_KEY(ORG))).toBe('open');
  });

  it('is scoped per org: org A tripping does not open org B', async () => {
    const m = await mod();
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure({ redis, config }, ORG);

    expect((await m.evaluateBreaker({ redis, config }, ORG_B)).state).toBe('closed');
  });

  it('success clears both the streak and the open state', async () => {
    const m = await mod();
    const redis = fakeRedis();
    const deps = { redis, config };
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure(deps, ORG);
    expect(redis.store.get(m.BREAKER_STATE_KEY(ORG))).toBe('open');

    await m.recordBreakerSuccess(deps, ORG);

    expect(redis.store.get(m.BREAKER_STATE_KEY(ORG))).toBeUndefined();
    expect(redis.store.get(m.BREAKER_FAILS_KEY(ORG))).toBeUndefined();
    expect((await m.evaluateBreaker(deps, ORG)).state).toBe('closed');
  });
});

describe('burn breaker: half-open probe election', () => {
  it('elects exactly ONE prober across many replicas; the rest short-circuit', async () => {
    const m = await mod();
    const sharedRedis = fakeRedis();
    const deps = { redis: sharedRedis, config };
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure(deps, ORG);

    // Ten replicas all discover the open breaker in the same probe window.
    const states = await Promise.all(
      Array.from({ length: 10 }, () => m.evaluateBreaker(deps, ORG).then((r) => r.state)),
    );

    expect(states.filter((s) => s === 'half_open')).toHaveLength(1);
    expect(states.filter((s) => s === 'open')).toHaveLength(9);
  });

  it('the NX key is what makes it single-flight', async () => {
    const m = await mod();
    const redis = fakeRedis();
    const deps = { redis, config };
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure(deps, ORG);

    await m.evaluateBreaker(deps, ORG);
    expect(redis.calls.some((c) => c === `set ${m.BREAKER_PROBE_KEY(ORG)} NX`)).toBe(true);
    expect(redis.store.has(m.BREAKER_PROBE_KEY(ORG))).toBe(true);
  });
});

describe('burn breaker: open short-circuits at ZERO network cost', () => {
  it('does not call fetch when the breaker is open', async () => {
    const m = await mod();
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure({ redis, config }, ORG);
    // Consume the one probe slot so the next caller is a plain short-circuit.
    await m.evaluateBreaker({ redis, config }, ORG);

    const fetchImpl = vi.fn();
    const result = await m.runBurnPrecheck(
      { redis, config, logger: silentLogger, fetchImpl: fetchImpl as any },
      {
        organization_id: ORG,
        work_ref_type: 'bill.expense',
        proposed_amount: 5000,
        currency: 'USD',
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
    expect(result.fail_open).toBe(true);
    expect(result.fail_open_reason).toBe('gate_unavailable');
    expect(result.breaker_state).toBe('open');
  });
});

describe('burn breaker: Redis failure is never fatal (spec 5.5.3)', () => {
  it('evaluateBreaker does not throw when every Redis op rejects', async () => {
    const m = await mod();
    const r = await m.evaluateBreaker({ redis: brokenRedis(), config }, ORG);
    expect(r.redisOk).toBe(false);
    expect(r.state).toBe('closed'); // fail OPEN: allow the call through
  });

  it('recordBreakerFailure does not throw and falls back to per-process counting', async () => {
    const m = await mod();
    const broken = brokenRedis();
    let opened = false;
    for (let i = 0; i < 5; i++) {
      const r = await m.recordBreakerFailure({ redis: broken, config }, ORG);
      expect(r.redisOk).toBe(false);
      opened = opened || r.opened;
    }
    // The in-process fallback still trips, it is just not shared across replicas.
    expect(opened).toBe(true);
  });

  it('a null redis (never connected) behaves exactly like a broken one', async () => {
    const m = await mod();
    await expect(m.evaluateBreaker({ redis: null, config }, ORG)).resolves.toMatchObject({
      state: 'closed',
      redisOk: false,
    });
    await expect(m.recordGateAttempt(null, ORG)).resolves.toBe(false);
    await expect(m.recordBreakerSuccess({ redis: null, config }, ORG)).resolves.toBeUndefined();
  });
});

describe('burn coverage counters (spec 5.5.2)', () => {
  it('recordGateAttempt increments the day-bucketed key and sets a TTL', async () => {
    const m = await mod();
    const redis = fakeRedis();
    await m.recordGateAttempt(redis, ORG, '20260719');
    expect(redis.store.get(`burn:gate_calls:${ORG}:20260719`)).toBe('1');
    expect(redis.calls).toContain(`expire burn:gate_calls:${ORG}:20260719`);
  });

  it('unconfigured and unavailable are SEPARATE keys', async () => {
    // They have identical coverage arithmetic but completely different remediations, so the
    // Gate Console has to be able to tell them apart.
    const m = await mod();
    const redis = fakeRedis();
    await m.recordGateFailure(redis, ORG, 'gate_not_configured', '20260719');
    await m.recordGateFailure(redis, ORG, 'gate_unavailable', '20260719');
    expect(redis.store.get(`burn:gate_unconfigured:${ORG}:20260719`)).toBe('1');
    expect(redis.store.get(`burn:gate_unavailable:${ORG}:20260719`)).toBe('1');
  });

  it('utcDayStamp is UTC and zero-padded', async () => {
    const m = await mod();
    expect(m.utcDayStamp(new Date(Date.UTC(2026, 6, 5, 23, 59)))).toBe('20260705');
    expect(m.utcDayStamp(new Date(Date.UTC(2026, 11, 31, 0, 0)))).toBe('20261231');
  });
});

describe('isGateWorthCalling (the worker per-job probe)', () => {
  it('is false when the gate is unconfigured', async () => {
    const m = await mod();
    const redis = fakeRedis();
    await expect(
      m.isGateWorthCalling({ redis, config: { ...config, baseUrl: undefined } }, ORG),
    ).resolves.toBe(false);
  });

  it('is false when the breaker is open and the probe slot is taken', async () => {
    const m = await mod();
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure({ redis, config }, ORG);
    await m.evaluateBreaker({ redis, config }, ORG); // consume the probe election
    await expect(m.isGateWorthCalling({ redis, config }, ORG)).resolves.toBe(false);
  });

  it('is true in normal operation', async () => {
    const m = await mod();
    await expect(m.isGateWorthCalling({ redis: fakeRedis(), config }, ORG)).resolves.toBe(true);
  });
});
