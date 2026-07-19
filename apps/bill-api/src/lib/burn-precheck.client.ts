import type { BurnPrecheckResponse, BurnWorkRefType } from '@bigbluebam/shared';

/**
 * The Burn pre-transaction spend gate client, and the platform's FIRST circuit breaker.
 *
 * Burn spec 5.1, 5.2, 5.5, 5.5.1, 5.5.2, 5.5.3, 9.2.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────────────
 *
 *   THE GATE NEVER BLOCKS BECAUSE SOMETHING BROKE.
 *
 * Availability fails OPEN. Authentication fails CLOSED. Those are deliberately inverted;
 * do not harmonize them. Every error path in this file returns `allowed: true`. The only
 * way this module reports "do not write" is a burn-api response that is explicitly an
 * ENFORCED `deny` verdict, which by spec 5.3 requires a deterministic target above
 * deny_threshold against a human-confirmed, priced envelope, in blocking mode, on an
 * enabled class. Anything else -- a timeout, a 5xx, a connect failure, an open breaker,
 * an unset URL, a Redis outage, a malformed body -- posts the charge.
 *
 * ── WHY THIS IS THE FIRST BREAKER IN THE TREE ───────────────────────────────────────
 *
 * Grepping apps/ and packages/ for circuitBreaker|CircuitBreaker|halfOpen|half_open
 * returns zero files. There is no in-tree precedent to copy, so this establishes one.
 * Note specifically that apps/bulwark-api/src/services/gate.service.ts is NOT the model:
 * that is a Redis SET used as a per-org dispatch cache, with no state machine, no failure
 * counter, and no half-open concept. The real precedent reused here is the Redis primitive
 * at apps/bill-api/src/services/sequence.service.ts:50 -- SET key value PX ms NX -- which
 * is what the probe election below is built on.
 *
 * ── MULTI-REPLICA CORRECTNESS ───────────────────────────────────────────────────────
 *
 * bill-api scales horizontally, so the breaker CANNOT be per-process state:
 *
 *   - The failure counter is a shared atomic INCR on burn:breaker:fails:<org>. Five
 *     replicas each seeing one failure must trip a threshold-5 breaker, and they do.
 *   - The open state lives in burn:breaker:state:<org>, so a replica that has personally
 *     never called burn-api still short-circuits at zero network cost.
 *   - The half-open probe takes burn:breaker:probe:<org> under SET ... PX ... NX, so a
 *     recovering burn-api is probed by exactly ONE replica per probe interval rather than
 *     stampeded by all of them the instant the open window lapses.
 *
 * The open-state TTL is deliberately MUCH longer than the probe interval (see
 * OPEN_STATE_TTL_MULTIPLIER). If they were equal, the state key would expire on its own
 * every probe interval and every replica would go straight through, which would make the
 * NX election decorative. Instead the state key persists and recovery happens only when a
 * single elected prober succeeds and clears it.
 *
 * ── WHY EVERY REDIS TOUCH IS WRAPPED ────────────────────────────────────────────────
 *
 * docker-compose.yml runs the single redis with --maxmemory 256mb --maxmemory-policy
 * noeviction, and the compose comment is explicit that AT THE CAP WRITES ERROR OUT BY
 * DESIGN. An unwrapped redis.incr() inside a Fastify preHandler would therefore throw,
 * reject the request, and BLOCK THE EXPENSE WRITE -- violating the one rule the entire
 * design rests on, in exactly the operating condition where you least want money to stop.
 * So every Redis call here goes through withRedis(), which never throws, and on any Redis
 * error the breaker degrades to a per-process in-process fallback and the verdict becomes
 * allow/redis_unavailable. This follows the graceful-degradation shape of
 * apps/mcp-server/src/lib/confirm-token-store.ts (Redis-backed, in-process fallback).
 */

// ---------------------------------------------------------------------------
// Redis key shapes (spec 5.5.1 / 5.5.2)
// ---------------------------------------------------------------------------

export const BREAKER_FAILS_KEY = (orgId: string) => `burn:breaker:fails:${orgId}`;
export const BREAKER_STATE_KEY = (orgId: string) => `burn:breaker:state:${orgId}`;
export const BREAKER_PROBE_KEY = (orgId: string) => `burn:breaker:probe:${orgId}`;

export const GATE_CALLS_KEY = (orgId: string, day: string) => `burn:gate_calls:${orgId}:${day}`;
export const GATE_UNAVAILABLE_KEY = (orgId: string, day: string) =>
  `burn:gate_unavailable:${orgId}:${day}`;
export const GATE_UNCONFIGURED_KEY = (orgId: string, day: string) =>
  `burn:gate_unconfigured:${orgId}:${day}`;

/** Coverage counters are drained by burn-calibration-recompute over a trailing 7 days. */
export const COVERAGE_COUNTER_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How much longer the open-state key lives than one probe interval. See the multi-replica
 * note above: if this were 1 the state key would self-expire each interval and the NX
 * election would never actually gate anything.
 */
export const OPEN_STATE_TTL_MULTIPLIER = 20;

/** Failure-counter window. Long enough to accumulate a real streak, short enough to decay. */
export const FAILS_TTL_MULTIPLIER = 4;

/** Stable log codes, asserted by tests and read by the Gate Console (spec 5.5.2). */
export const LOG_CODE_UNAVAILABLE = 'BURN_GATE_UNAVAILABLE';
export const LOG_CODE_NOT_CONFIGURED = 'BURN_GATE_NOT_CONFIGURED';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of ioredis this module uses. Narrowed so tests can supply a fake. */
export interface BurnBreakerRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    condition: 'NX',
  ): Promise<string | null>;
  // The open-state write has no NX condition, hence a second overload shape.
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<string | null>;
}

export interface BurnBreakerLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  debug?(obj: Record<string, unknown>, msg?: string): void;
}

export interface BurnPrecheckConfig {
  /** Unset/empty means the gate is not configured. Every charge posts; coverage reads 0%. */
  baseUrl?: string | undefined;
  /** The AUTHORITATIVE deadline. Never read from burn-api. */
  timeoutMs: number;
  breakerThreshold: number;
  breakerProbeMs: number;
  internalSecret?: string | undefined;
}

/** The charge being gated. Mirrors burnInternalPrecheckRequestSchema in @bigbluebam/shared. */
export interface BurnPrecheckInput {
  organization_id: string;
  work_ref_type: BurnWorkRefType;
  work_ref_id?: string | null;
  project_id?: string | null;
  proposed_amount: number;
  currency: string;
  title?: string | null;
  description?: string | null;
  occurred_at?: string | null;
  acting_user_id?: string | null;
}

export type BurnBreakerState = 'closed' | 'open' | 'half_open';

/**
 * Why the gate did not produce a verdict. Values match BurnPrecheckVerdictReason in
 * @bigbluebam/shared so the fail-open reason can be surfaced verbatim.
 */
export type BurnFailOpenReason =
  | 'gate_not_configured'
  | 'gate_unavailable'
  | 'redis_unavailable';

export interface BurnPrecheckResult {
  /**
   * FALSE only on an enforced deny from burn-api. True on every error path, every
   * non-deny verdict, and every unenforced (advisory-mode) deny.
   */
  allowed: boolean;
  /** The burn-api body when the gate actually ran, else null. */
  response: BurnPrecheckResponse | null;
  /** True when the gate did not produce a verdict and the charge posts regardless. */
  fail_open: boolean;
  /** Reason the gate did not run. Null when it did. */
  fail_open_reason: BurnFailOpenReason | null;
  /**
   * The marker to stamp on the created row (spec 6.1, "Deferred fail-open outcome"), so
   * burn-variance-sweep raises ungated_charge against REAL ROWS rather than a bare count.
   */
  gate_marker: 'unavailable' | 'not_configured' | null;
  latency_ms: number;
  breaker_state: BurnBreakerState;
  /** False when a Redis touch failed and the in-process fallback took over. */
  redis_ok: boolean;
}

// ---------------------------------------------------------------------------
// In-process fallback (spec 5.5.3)
// ---------------------------------------------------------------------------

interface FallbackBreakerEntry {
  fails: number;
  openUntil: number;
  lastProbeAt: number;
}

/**
 * Per-process breaker used ONLY when Redis is unreachable or erroring. It is deliberately
 * NOT shared and NOT authoritative: with N replicas it takes up to N x threshold failures
 * to trip. That is the correct trade. The alternative -- letting a Redis outage propagate
 * out of the preHandler -- blocks money, and every additional burn-api call made while the
 * fallback is still counting merely fails open faster.
 */
const fallbackBreakers = new Map<string, FallbackBreakerEntry>();

/** Test seam. Not exported through the barrel; used by the breaker unit tests. */
export function __resetFallbackBreakers(): void {
  fallbackBreakers.clear();
}

function fallbackEntry(orgId: string): FallbackBreakerEntry {
  let entry = fallbackBreakers.get(orgId);
  if (!entry) {
    entry = { fails: 0, openUntil: 0, lastProbeAt: 0 };
    fallbackBreakers.set(orgId, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC yyyymmdd. The counters are day-bucketed and drained over a trailing 7 days. */
export function utcDayStamp(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * The ONLY way this module touches Redis. Never throws. Returns `null` on any failure and
 * flips the caller's redisOk flag, which is what routes the request onto the in-process
 * fallback and the redis_unavailable reason. See the header note about noeviction.
 */
async function withRedis<T>(
  redis: BurnBreakerRedis | null | undefined,
  op: (r: BurnBreakerRedis) => Promise<T>,
  onError: () => void,
): Promise<T | null> {
  if (!redis) {
    onError();
    return null;
  }
  try {
    return await op(redis);
  } catch {
    onError();
    return null;
  }
}

// ---------------------------------------------------------------------------
// The breaker
// ---------------------------------------------------------------------------

export interface BurnBreakerDeps {
  redis: BurnBreakerRedis | null;
  config: BurnPrecheckConfig;
  now?: () => number;
}

/**
 * Decide whether this call may go to the network, and in what role.
 *
 *  - `closed`    : normal operation, make the call.
 *  - `half_open` : the breaker is open but THIS replica won the NX probe election, so it
 *                  makes exactly one real call whose result decides recovery.
 *  - `open`      : short-circuit at ZERO network cost.
 *
 * `redisOk === false` means every decision below came from the in-process fallback.
 */
export async function evaluateBreaker(
  deps: BurnBreakerDeps,
  orgId: string,
): Promise<{ state: BurnBreakerState; redisOk: boolean }> {
  const now = deps.now ?? Date.now;
  let redisOk = true;
  const markRedisDown = () => {
    redisOk = false;
  };

  const state = await withRedis(
    deps.redis,
    (r) => r.get(BREAKER_STATE_KEY(orgId)),
    markRedisDown,
  );

  if (!redisOk) {
    // Redis is down. Fall back to per-process state.
    const entry = fallbackEntry(orgId);
    const t = now();
    if (entry.openUntil > t) {
      if (t - entry.lastProbeAt >= deps.config.breakerProbeMs) {
        entry.lastProbeAt = t;
        return { state: 'half_open', redisOk: false };
      }
      return { state: 'open', redisOk: false };
    }
    return { state: 'closed', redisOk: false };
  }

  if (state !== 'open') return { state: 'closed', redisOk: true };

  // Breaker is open. Exactly one replica per probe interval gets to test the water.
  const won = await withRedis(
    deps.redis,
    (r) =>
      r.set(
        BREAKER_PROBE_KEY(orgId),
        String(now()),
        'PX',
        deps.config.breakerProbeMs,
        'NX',
      ),
    markRedisDown,
  );

  if (!redisOk) return { state: 'open', redisOk: false };
  return { state: won === 'OK' ? 'half_open' : 'open', redisOk: true };
}

/**
 * Record a failed call. Trips the breaker on the Nth consecutive failure.
 *
 * The counter is a shared atomic INCR precisely so that five replicas seeing one failure
 * each still trip a threshold-5 breaker; per-process counting would need 5N failures.
 */
export async function recordBreakerFailure(
  deps: BurnBreakerDeps,
  orgId: string,
): Promise<{ opened: boolean; fails: number; redisOk: boolean }> {
  const now = deps.now ?? Date.now;
  let redisOk = true;
  const markRedisDown = () => {
    redisOk = false;
  };

  const failsKey = BREAKER_FAILS_KEY(orgId);
  const fails = await withRedis(deps.redis, (r) => r.incr(failsKey), markRedisDown);

  if (!redisOk || fails === null) {
    const entry = fallbackEntry(orgId);
    entry.fails += 1;
    const opened = entry.fails >= deps.config.breakerThreshold;
    if (opened) {
      entry.openUntil = now() + deps.config.breakerProbeMs * OPEN_STATE_TTL_MULTIPLIER;
      entry.fails = 0;
    }
    return { opened, fails: entry.fails, redisOk: false };
  }

  await withRedis(
    deps.redis,
    (r) =>
      r.expire(
        failsKey,
        Math.ceil((deps.config.breakerProbeMs * FAILS_TTL_MULTIPLIER) / 1000),
      ),
    markRedisDown,
  );

  if (fails < deps.config.breakerThreshold) {
    return { opened: false, fails, redisOk };
  }

  // Trip. The open state deliberately outlives one probe interval (see the header): the
  // NX probe election, not TTL expiry, is what lets traffic back through.
  await withRedis(
    deps.redis,
    (r) =>
      r.set(
        BREAKER_STATE_KEY(orgId),
        'open',
        'PX',
        deps.config.breakerProbeMs * OPEN_STATE_TTL_MULTIPLIER,
      ),
    markRedisDown,
  );
  await withRedis(deps.redis, (r) => r.del(failsKey), markRedisDown);
  return { opened: true, fails, redisOk };
}

/** Record a successful call: clear the streak and, if open, close the breaker. */
export async function recordBreakerSuccess(
  deps: BurnBreakerDeps,
  orgId: string,
): Promise<void> {
  const noop = () => {
    /* a Redis failure on the success path is not worth degrading anything for */
  };
  await withRedis(
    deps.redis,
    (r) => r.del(BREAKER_FAILS_KEY(orgId), BREAKER_STATE_KEY(orgId), BREAKER_PROBE_KEY(orgId)),
    noop,
  );
  const entry = fallbackBreakers.get(orgId);
  if (entry) {
    entry.fails = 0;
    entry.openUntil = 0;
  }
}

// ---------------------------------------------------------------------------
// Coverage counters (spec 5.5.2)
// ---------------------------------------------------------------------------

/**
 * INCR burn:gate_calls:<org>:<yyyymmdd> on EVERY gated write attempt, INCLUDING the
 * unconfigured no-op.
 *
 * That "including" is not a detail, it is the whole point. The counters are incremented by
 * bill-api. If BURN_API_INTERNAL_URL is unset the client never runs, so if the increment
 * were inside the client neither counter would move, coverage would be 0/0 rather than a
 * number, and an org that promoted to blocking and then LOST the env var would see a
 * perfectly clean Gate Console while nothing whatsoever was being gated. Counting the
 * attempt makes a missing env var read as 0 PERCENT coverage, which trips the same
 * auto-demotion path as a burn-api outage. Hence: increment first, decide second.
 */
export async function recordGateAttempt(
  redis: BurnBreakerRedis | null,
  orgId: string,
  day: string = utcDayStamp(),
): Promise<boolean> {
  let ok = true;
  const key = GATE_CALLS_KEY(orgId, day);
  const n = await withRedis(redis, (r) => r.incr(key), () => {
    ok = false;
  });
  if (n !== null) {
    await withRedis(redis, (r) => r.expire(key, COVERAGE_COUNTER_TTL_SECONDS), () => {
      ok = false;
    });
  }
  return ok;
}

/**
 * INCR the matching failure counter. The Gate Console MUST be able to distinguish
 * "nobody configured this" from "the service is down" -- they have the same coverage
 * arithmetic but completely different remediations -- so they are separate keys.
 */
export async function recordGateFailure(
  redis: BurnBreakerRedis | null,
  orgId: string,
  reason: BurnFailOpenReason,
  day: string = utcDayStamp(),
): Promise<boolean> {
  let ok = true;
  const key =
    reason === 'gate_not_configured'
      ? GATE_UNCONFIGURED_KEY(orgId, day)
      : GATE_UNAVAILABLE_KEY(orgId, day);
  const n = await withRedis(redis, (r) => r.incr(key), () => {
    ok = false;
  });
  if (n !== null) {
    await withRedis(redis, (r) => r.expire(key, COVERAGE_COUNTER_TTL_SECONDS), () => {
      ok = false;
    });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

function failOpen(
  reason: BurnFailOpenReason,
  latencyMs: number,
  breakerState: BurnBreakerState,
  redisOk: boolean,
): BurnPrecheckResult {
  return {
    allowed: true,
    response: null,
    fail_open: true,
    fail_open_reason: reason,
    gate_marker: reason === 'gate_not_configured' ? 'not_configured' : 'unavailable',
    latency_ms: latencyMs,
    breaker_state: breakerState,
    redis_ok: redisOk,
  };
}

export interface BurnPrecheckClientDeps {
  redis: BurnBreakerRedis | null;
  config: BurnPrecheckConfig;
  logger: BurnBreakerLogger;
  /** Injectable for tests. Defaults to global fetch (Node 22). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Run the gate for one charge.
 *
 * Ordering is load-bearing:
 *   1. Count the attempt (ALWAYS, even unconfigured -- see recordGateAttempt).
 *   2. Unconfigured? fail open as gate_not_configured.
 *   3. Breaker open? fail open as gate_unavailable at ZERO network cost.
 *   4. Call burn-api under an AbortController on BURN_PRECHECK_TIMEOUT_MS.
 *   5. Timeout / 5xx / connect error -> record a breaker failure, fail open.
 *   6. 2xx -> clear the breaker, return the verdict.
 *
 * Never throws. A caller may treat a rejection from this function as a bug.
 */
export async function runBurnPrecheck(
  deps: BurnPrecheckClientDeps,
  input: BurnPrecheckInput,
): Promise<BurnPrecheckResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const orgId = input.organization_id;
  const day = utcDayStamp(new Date(started));

  // 1. Always count the attempt, before any other decision.
  const attemptOk = await recordGateAttempt(deps.redis, orgId, day);

  const baseUrl = deps.config.baseUrl?.trim();

  // 2. Not configured. Distinguishable from unavailable, and it still costs coverage.
  if (!baseUrl) {
    await recordGateFailure(deps.redis, orgId, 'gate_not_configured', day);
    deps.logger.warn(
      {
        code: LOG_CODE_NOT_CONFIGURED,
        org_id: orgId,
        work_ref_type: input.work_ref_type,
        redis_ok: attemptOk,
      },
      'burn gate not configured: BURN_API_INTERNAL_URL is unset, charge posts ungated',
    );
    return failOpen('gate_not_configured', now() - started, 'closed', attemptOk);
  }

  // 3. Breaker.
  const breakerDeps: BurnBreakerDeps = {
    redis: deps.redis,
    config: deps.config,
    now: deps.now,
  };
  const { state, redisOk } = await evaluateBreaker(breakerDeps, orgId);

  if (state === 'open') {
    await recordGateFailure(deps.redis, orgId, 'gate_unavailable', day);
    deps.logger.warn(
      { code: LOG_CODE_UNAVAILABLE, org_id: orgId, breaker_state: 'open', redis_ok: redisOk },
      'burn gate short-circuited by an open breaker, charge posts ungated',
    );
    return failOpen('gate_unavailable', now() - started, 'open', redisOk);
  }

  // A Redis outage is its own reported reason (spec 5.5, 12.1) even though the call is
  // still attempted below: the operator needs to see "Redis" rather than a generic
  // unavailable, because the remediation is completely different.
  const redisDown = !redisOk;

  // 4. The call. AbortController on the bill-api-side deadline.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.config.timeoutMs);
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/internal/precheck`;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (deps.config.internalSecret) headers['X-Internal-Secret'] = deps.config.internalSecret;

    const res = await doFetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        organization_id: orgId,
        work_ref_type: input.work_ref_type,
        work_ref_id: input.work_ref_id ?? null,
        project_id: input.project_id ?? null,
        proposed_amount: input.proposed_amount,
        currency: input.currency,
        title: input.title ?? null,
        description: input.description ?? null,
        occurred_at: input.occurred_at ?? null,
        acting_user_id: input.acting_user_id ?? null,
      }),
    });

    // 5xx is a burn-api health signal and counts toward the breaker. A 4xx is NOT: a 429
    // from burn-api's own rate limiter, or a 400 on a payload we built wrong, says nothing
    // about burn-api's health, and spec 5.6 is explicit that 429s must never be
    // attributable to coverage loss. Both still fail open; only 5xx trips the breaker.
    if (res.status >= 500) {
      await recordBreakerFailure(breakerDeps, orgId);
      await recordGateFailure(deps.redis, orgId, 'gate_unavailable', day);
      deps.logger.warn(
        { code: LOG_CODE_UNAVAILABLE, org_id: orgId, status: res.status },
        'burn gate returned 5xx, charge posts ungated',
      );
      return failOpen(
        redisDown ? 'redis_unavailable' : 'gate_unavailable',
        now() - started,
        state,
        !redisDown,
      );
    }

    if (!res.ok) {
      await recordGateFailure(deps.redis, orgId, 'gate_unavailable', day);
      deps.logger.warn(
        { code: LOG_CODE_UNAVAILABLE, org_id: orgId, status: res.status },
        'burn gate returned a non-2xx client status, charge posts ungated',
      );
      return failOpen(
        redisDown ? 'redis_unavailable' : 'gate_unavailable',
        now() - started,
        state,
        !redisDown,
      );
    }

    const body = (await res.json()) as { data?: BurnPrecheckResponse } | BurnPrecheckResponse;
    const verdict = ('data' in body && body.data ? body.data : body) as BurnPrecheckResponse;

    await recordBreakerSuccess(breakerDeps, orgId);

    // A malformed 200 is treated as an outage, not as an allow-with-no-record.
    if (!verdict || typeof verdict.verdict !== 'string') {
      await recordGateFailure(deps.redis, orgId, 'gate_unavailable', day);
      deps.logger.warn(
        { code: LOG_CODE_UNAVAILABLE, org_id: orgId },
        'burn gate returned an unrecognized body, charge posts ungated',
      );
      return failOpen('gate_unavailable', now() - started, state, !redisDown);
    }

    // THE ONLY BLOCKING PATH IN THIS FILE. An enforced deny. Everything else allows,
    // including needs_mapping (which posts with an inline note and a queue item) and
    // every advisory-mode verdict, where enforced is false by construction.
    const blocked = verdict.verdict === 'deny' && verdict.enforced === true;

    return {
      allowed: !blocked,
      response: verdict,
      fail_open: false,
      fail_open_reason: null,
      gate_marker: null,
      latency_ms: now() - started,
      breaker_state: state,
      redis_ok: !redisDown,
    };
  } catch (err) {
    // Timeout (AbortError), DNS failure, connection refused, socket hangup, bad JSON.
    // All are burn-api health signals and all fail open.
    await recordBreakerFailure(breakerDeps, orgId);
    await recordGateFailure(deps.redis, orgId, 'gate_unavailable', day);
    const aborted = err instanceof Error && err.name === 'AbortError';
    deps.logger.warn(
      {
        code: LOG_CODE_UNAVAILABLE,
        org_id: orgId,
        timed_out: aborted,
        timeout_ms: deps.config.timeoutMs,
        err: err instanceof Error ? err.message : String(err),
      },
      aborted
        ? 'burn gate timed out, charge posts ungated'
        : 'burn gate unreachable, charge posts ungated',
    );
    return failOpen(
      redisDown ? 'redis_unavailable' : 'gate_unavailable',
      now() - started,
      state,
      !redisDown,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap, per-JOB breaker probe for the worker's serial sweeps.
 *
 * apps/worker/src/jobs/bill-recurring-generate.job.ts loops serially over up to 200 due
 * schedules. Calling the gate per schedule during a burn-api outage would add
 * N x BURN_PRECHECK_TIMEOUT_MS to the job -- 160 seconds at the default for a full batch --
 * so the breaker is consulted ONCE per job and the whole sweep runs ungated if it is open.
 * Returns true when the gate is worth calling at all.
 */
export async function isGateWorthCalling(
  deps: BurnBreakerDeps & { logger?: BurnBreakerLogger },
  orgId: string,
): Promise<boolean> {
  if (!deps.config.baseUrl?.trim()) return false;
  const { state } = await evaluateBreaker(deps, orgId);
  return state !== 'open';
}
