import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Burn spec 12.1, "The gate" -> Fail-open. FIVE assertions, each with the correct
 * verdict_reason, and IN EVERY ONE THE EXPENSE POSTS:
 *
 *   1. burn-api unreachable                    -> gate_unavailable
 *   2. breaker open                            -> gate_unavailable, zero network cost
 *   3. timeout past BURN_PRECHECK_TIMEOUT_MS   -> gate_unavailable
 *   4. BURN_API_INTERNAL_URL unset             -> gate_not_configured
 *   5. Redis unreachable                       -> redis_unavailable
 *
 * Plus spec 5.5.2 / R2-I3: THE UNCONFIGURED CASE MUST READ AS 0 PERCENT COVERAGE, NOT 0/0.
 * That one deserves its own note. The coverage counters are incremented by bill-api. If
 * they were only incremented when the client actually ran, then with BURN_API_INTERNAL_URL
 * unset neither counter would move, coverage would be undefined rather than a number, and
 * an org that promoted to blocking and then LOST the env var would see a perfectly clean
 * Gate Console while nothing at all was being gated. Counting the attempt makes a missing
 * env var read as 0 percent and trip the same auto-demotion path as an outage.
 *
 * These tests exercise the client directly rather than through a Fastify instance. The
 * property under test -- "the charge posts" -- is expressed here as `allowed === true`,
 * which is precisely what the preHandler branches on: it only ever returns 409 when
 * `allowed` is false, which only ever happens on an ENFORCED DENY from burn-api.
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
    BURN_PRECHECK_TIMEOUT_MS: 50,
    BURN_PRECHECK_BREAKER_THRESHOLD: 5,
    BURN_PRECHECK_BREAKER_PROBE_MS: 30000,
    INTERNAL_SERVICE_SECRET: 'b'.repeat(32),
  },
}));

const ORG = '00000000-0000-0000-0000-0000000000aa';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async incr(key: string) {
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    },
    async expire() {
      return 1;
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n += 1;
      return n;
    },
    async set(key: string, value: string, _m: 'PX', _t: number, condition?: 'NX') {
      if (condition === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
  } as any;
}

function brokenRedis() {
  const boom = async () => {
    throw new Error('OOM command not allowed when used memory > maxmemory');
  };
  return { incr: boom, expire: boom, get: boom, del: boom, set: boom } as any;
}

const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

const baseConfig = {
  baseUrl: 'http://burn-api:4022',
  timeoutMs: 50,
  breakerThreshold: 5,
  breakerProbeMs: 30000,
  internalSecret: 'b'.repeat(32),
};

const charge = {
  organization_id: ORG,
  work_ref_type: 'bill.expense' as const,
  work_ref_id: null,
  project_id: null,
  proposed_amount: 42_000,
  currency: 'USD',
};

async function mod() {
  return import('../src/lib/burn-precheck.client.js');
}

beforeEach(async () => {
  const { __resetFallbackBreakers } = await mod();
  __resetFallbackBreakers();
  logger.warn.mockClear();
});

// ---------------------------------------------------------------------------
// 1. burn-api unreachable
// ---------------------------------------------------------------------------

describe('12.1 fail-open 1/5: burn-api unreachable', () => {
  it('the expense posts, with verdict_reason gate_unavailable', async () => {
    const m = await mod();
    const fetchImpl = vi.fn().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 172.18.0.9:4022'), { code: 'ECONNREFUSED' }),
    );
    const redis = fakeRedis();

    const result = await m.runBurnPrecheck(
      { redis, config: baseConfig, logger, fetchImpl: fetchImpl as any },
      charge,
    );

    expect(result.allowed).toBe(true);
    expect(result.fail_open).toBe(true);
    expect(result.fail_open_reason).toBe('gate_unavailable');
    expect(result.gate_marker).toBe('unavailable');
    expect(result.response).toBeNull();
  });

  it('logs the stable BURN_GATE_UNAVAILABLE code', async () => {
    const m = await mod();
    await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: vi.fn().mockRejectedValue(new Error('nope')) as any,
      },
      charge,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BURN_GATE_UNAVAILABLE' }),
      expect.any(String),
    );
  });

  it('counts toward the breaker so a sustained outage stops costing round trips', async () => {
    const m = await mod();
    const redis = fakeRedis();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    const deps = { redis, config: baseConfig, logger, fetchImpl: fetchImpl as any };

    for (let i = 0; i < 5; i++) await m.runBurnPrecheck(deps, charge);
    expect(redis.store.get(m.BREAKER_STATE_KEY(ORG))).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// 2. breaker open
// ---------------------------------------------------------------------------

describe('12.1 fail-open 2/5: breaker open', () => {
  it('the expense posts at ZERO network cost', async () => {
    const m = await mod();
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure({ redis, config: baseConfig }, ORG);
    await m.evaluateBreaker({ redis, config: baseConfig }, ORG); // consume the probe slot

    const fetchImpl = vi.fn();
    const result = await m.runBurnPrecheck(
      { redis, config: baseConfig, logger, fetchImpl: fetchImpl as any },
      charge,
    );

    expect(result.allowed).toBe(true);
    expect(result.fail_open_reason).toBe('gate_unavailable');
    expect(result.breaker_state).toBe('open');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still counts the attempt, so an open breaker costs coverage', async () => {
    const m = await mod();
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await m.recordBreakerFailure({ redis, config: baseConfig }, ORG);
    await m.evaluateBreaker({ redis, config: baseConfig }, ORG);

    const day = m.utcDayStamp();
    const before = Number(redis.store.get(m.GATE_CALLS_KEY(ORG, day)) ?? '0');
    await m.runBurnPrecheck(
      { redis, config: baseConfig, logger, fetchImpl: vi.fn() as any },
      charge,
    );
    expect(Number(redis.store.get(m.GATE_CALLS_KEY(ORG, day)))).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. timeout
// ---------------------------------------------------------------------------

describe('12.1 fail-open 3/5: timeout past BURN_PRECHECK_TIMEOUT_MS', () => {
  it('the expense posts, and latency_ms is recorded', async () => {
    const m = await mod();
    // A fetch that respects the AbortController but never resolves on its own. This is what
    // a burn-api that accepted the connection and then hung looks like.
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    });

    const result = await m.runBurnPrecheck(
      { redis: fakeRedis(), config: { ...baseConfig, timeoutMs: 30 }, logger, fetchImpl: fetchImpl as any },
      charge,
    );

    expect(result.allowed).toBe(true);
    expect(result.fail_open).toBe(true);
    expect(result.fail_open_reason).toBe('gate_unavailable');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BURN_GATE_UNAVAILABLE', timed_out: true }),
      expect.any(String),
    );
  });

  it('the deadline is the bill-api-side constant, NOT anything burn-api told us', async () => {
    // A timeout budget stored in the service it is meant to bound cannot be read when that
    // service is down. burn_org_settings.precheck_budget_ms is CHECK-clamped to [100, 750],
    // strictly below the 800ms client default, and is never consulted here.
    const m = await mod();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ verdict: 'allow', enforced: false }), { status: 200 });
    });

    await m.runBurnPrecheck(
      { redis: fakeRedis(), config: baseConfig, logger, fetchImpl: fetchImpl as any },
      charge,
    );
    expect(observedSignal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. BURN_API_INTERNAL_URL unset
// ---------------------------------------------------------------------------

describe('12.1 fail-open 4/5: BURN_API_INTERNAL_URL unset', () => {
  it('the expense posts with verdict_reason gate_not_configured, and no fetch happens', async () => {
    const m = await mod();
    const fetchImpl = vi.fn();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: { ...baseConfig, baseUrl: undefined },
        logger,
        fetchImpl: fetchImpl as any,
      },
      charge,
    );

    expect(result.allowed).toBe(true);
    expect(result.fail_open_reason).toBe('gate_not_configured');
    expect(result.gate_marker).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BURN_GATE_NOT_CONFIGURED' }),
      expect.any(String),
    );
  });

  it('an empty-string URL is treated as unset, not as a relative base', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      { redis: fakeRedis(), config: { ...baseConfig, baseUrl: '   ' }, logger, fetchImpl: vi.fn() as any },
      charge,
    );
    expect(result.fail_open_reason).toBe('gate_not_configured');
  });

  it('R2-I3: THE UNCONFIGURED NO-OP STILL INCREMENTS burn:gate_calls', async () => {
    // The point of the whole mechanism. Without this increment, an org that promoted to
    // blocking and then lost the env var would see coverage 0/0 and a clean console while
    // nothing was gated. With it, coverage reads 0 percent and the same auto-demotion path
    // fires as for a real outage.
    const m = await mod();
    const redis = fakeRedis();
    const day = m.utcDayStamp();

    await m.runBurnPrecheck(
      { redis, config: { ...baseConfig, baseUrl: undefined }, logger, fetchImpl: vi.fn() as any },
      charge,
    );

    const calls = Number(redis.store.get(m.GATE_CALLS_KEY(ORG, day)) ?? '0');
    const unconfigured = Number(redis.store.get(m.GATE_UNCONFIGURED_KEY(ORG, day)) ?? '0');

    expect(calls).toBe(1);
    expect(unconfigured).toBe(1);
    // Coverage = 1 - (failures / attempts) = 0 percent. A defined number, not 0/0.
    expect(1 - unconfigured / calls).toBe(0);
  });

  it('unconfigured does NOT increment the unavailable counter (they must stay distinguishable)', async () => {
    const m = await mod();
    const redis = fakeRedis();
    const day = m.utcDayStamp();
    await m.runBurnPrecheck(
      { redis, config: { ...baseConfig, baseUrl: undefined }, logger, fetchImpl: vi.fn() as any },
      charge,
    );
    expect(redis.store.get(m.GATE_UNAVAILABLE_KEY(ORG, day))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Redis unreachable
// ---------------------------------------------------------------------------

describe('12.1 fail-open 5/5: Redis unreachable', () => {
  it('the expense posts, with verdict_reason redis_unavailable', async () => {
    const m = await mod();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('also down'));

    const result = await m.runBurnPrecheck(
      { redis: brokenRedis(), config: baseConfig, logger, fetchImpl: fetchImpl as any },
      charge,
    );

    expect(result.allowed).toBe(true);
    expect(result.fail_open).toBe(true);
    expect(result.fail_open_reason).toBe('redis_unavailable');
    expect(result.redis_ok).toBe(false);
  });

  it('THE CRITICAL PROPERTY: a Redis outage never throws out of the client', async () => {
    // Redis runs with --maxmemory 256mb --maxmemory-policy noeviction, where writes ERROR
    // OUT at the cap by design. An unwrapped Redis call inside the preHandler would reject
    // the request and BLOCK THE EXPENSE WRITE, violating the one rule the whole design
    // rests on -- in exactly the operating condition where you least want money to stop.
    const m = await mod();
    await expect(
      m.runBurnPrecheck(
        {
          redis: brokenRedis(),
          config: baseConfig,
          logger,
          fetchImpl: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ verdict: 'allow', enforced: false }), { status: 200 }),
          ) as any,
        },
        charge,
      ),
    ).resolves.toBeDefined();
  });

  it('a Redis outage still lets a healthy burn-api decide', async () => {
    // Degraded, not disabled: the breaker falls back to per-process state but the gate
    // itself keeps working.
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: brokenRedis(),
        config: baseConfig,
        logger,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({ verdict: 'allow', verdict_reason: 'within_envelope', enforced: true }),
            { status: 200 },
          ),
        ) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(true);
    expect(result.response?.verdict).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// The ONE blocking path, and the things that must NOT block
// ---------------------------------------------------------------------------

describe('the only verdict that blocks is an ENFORCED deny', () => {
  function respond(body: unknown, status = 200) {
    return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  }

  it('an enforced deny blocks', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: respond({
          precheck_id: '00000000-0000-0000-0000-0000000000ff',
          verdict: 'deny',
          verdict_reason: 'envelope_would_exceed',
          enforced: true,
        }) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(false);
    expect(result.fail_open).toBe(false);
    expect(result.gate_marker).toBeNull();
  });

  it('an UNENFORCED deny (advisory mode) does NOT block', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: respond({ verdict: 'deny', verdict_reason: 'envelope_would_exceed', enforced: false }) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(true);
  });

  it('needs_mapping NEVER blocks, even when enforced is somehow true', async () => {
    // Spec 5.3: needs_mapping posts with an inline note and a queue item. It is the single
    // most common non-allow verdict and blocking on it would make the gate unusable.
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: respond({ verdict: 'needs_mapping', verdict_reason: 'low_confidence_target', enforced: true }) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(true);
  });

  it('allow_with_note does not block', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: respond({ verdict: 'allow_with_note', verdict_reason: 'envelope_unpriced', enforced: true }) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(true);
  });

  it('a 5xx fails open AND trips the breaker; a 4xx fails open and does NOT', async () => {
    // Spec 5.6: a 429 from burn-api's own rate limiter is not a health signal and must
    // never be attributable to coverage loss via the breaker.
    const m = await mod();

    const redis5xx = fakeRedis();
    for (let i = 0; i < 5; i++) {
      await m.runBurnPrecheck(
        { redis: redis5xx, config: baseConfig, logger, fetchImpl: respond({}, 503) as any },
        charge,
      );
    }
    expect(redis5xx.store.get(m.BREAKER_STATE_KEY(ORG))).toBe('open');

    const redis429 = fakeRedis();
    for (let i = 0; i < 10; i++) {
      const r = await m.runBurnPrecheck(
        { redis: redis429, config: baseConfig, logger, fetchImpl: respond({}, 429) as any },
        charge,
      );
      expect(r.allowed).toBe(true);
    }
    expect(redis429.store.get(m.BREAKER_STATE_KEY(ORG))).toBeUndefined();
  });

  it('a malformed 200 is treated as an outage, not as a silent allow-with-no-record', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      { redis: fakeRedis(), config: baseConfig, logger, fetchImpl: respond({ nonsense: true }) as any },
      charge,
    );
    expect(result.allowed).toBe(true);
    expect(result.fail_open).toBe(true);
    expect(result.gate_marker).toBe('unavailable');
  });

  it('unwraps a { data: ... } envelope as well as a bare body', async () => {
    const m = await mod();
    const result = await m.runBurnPrecheck(
      {
        redis: fakeRedis(),
        config: baseConfig,
        logger,
        fetchImpl: respond({ data: { verdict: 'deny', verdict_reason: 'envelope_exhausted', enforced: true } }) as any,
      },
      charge,
    );
    expect(result.allowed).toBe(false);
  });
});

describe('the request bill-api actually sends', () => {
  it('targets /v1/internal/precheck and carries the internal secret', async () => {
    const m = await mod();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verdict: 'allow', enforced: false }), { status: 200 }),
    );
    await m.runBurnPrecheck({ redis: fakeRedis(), config: baseConfig, logger, fetchImpl: fetchImpl as any }, charge);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://burn-api:4022/v1/internal/precheck');
    expect((init as any).headers['X-Internal-Secret']).toBe('b'.repeat(32));

    const body = JSON.parse((init as any).body);
    // organization_id is present so burn-api can derive the org from the VALIDATED PAYLOAD
    // and set the RLS GUC in the same transaction (spec 2.4 point 14).
    expect(body.organization_id).toBe(ORG);
    expect(body.work_ref_type).toBe('bill.expense');
    expect(body.proposed_amount).toBe(42_000);
    expect(body.currency).toBe('USD');
    // The idempotency key is SERVER-DERIVED and must NOT be sent by the caller.
    expect(body).not.toHaveProperty('idempotency_key');
  });

  it('does not strand a trailing slash on the base URL', async () => {
    const m = await mod();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verdict: 'allow', enforced: false }), { status: 200 }),
    );
    await m.runBurnPrecheck(
      { redis: fakeRedis(), config: { ...baseConfig, baseUrl: 'http://burn-api:4022//' }, logger, fetchImpl: fetchImpl as any },
      charge,
    );
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://burn-api:4022/v1/internal/precheck');
  });
});
