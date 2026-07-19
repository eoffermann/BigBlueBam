import Redis from 'ioredis';
import type { Logger } from 'pino';
import { loadEnv } from '../env.js';

/**
 * Worker-side Burn spend gate, for the `bill.recurring` class (Burn spec 5.2, 5.5.1, 9.2).
 *
 * ── WHY THIS IS A SEPARATE MODULE AND NOT AN IMPORT ────────────────────────────────
 *
 * The authoritative client is apps/bill-api/src/lib/burn-precheck.client.ts. The worker is
 * a separate pnpm package and does NOT depend on @bigbluebam/bill-api (bill-recurring-
 * generate.job.ts already replicates that service's cadence SQL for the same reason), so
 * the call path is restated here rather than imported. THE REDIS KEY NAMES ARE IDENTICAL
 * AND MUST STAY THAT WAY: the breaker bill-api trips is the breaker this consults, and the
 * coverage counters both increment are drained by one burn-calibration-recompute pass. If
 * you rename a key in either file, rename it in both, or the gate will report coverage for
 * a population it is not actually gating.
 *
 * ── ONE BREAKER CHECK PER JOB, NOT PER SCHEDULE ────────────────────────────────────
 *
 * bill-recurring-generate loops SERIALLY over up to 200 due schedules. A per-schedule gate
 * call during a burn-api outage would add N x BURN_PRECHECK_TIMEOUT_MS to the job: 160
 * seconds at the 800ms default for a full batch, on a daily billing sweep, entirely spent
 * waiting on a service that is known to be down. So the breaker is consulted ONCE per
 * (job, org) via createJobGate(), memoized, and if it is open the whole remaining sweep
 * runs ungated at zero network cost.
 *
 * Everything else about the posture is identical to bill-api's client: the gate never
 * blocks because something broke, every Redis touch is wrapped and non-throwing, and the
 * coverage counter increments on EVERY attempt including the unconfigured no-op so that a
 * missing BURN_API_INTERNAL_URL reads as 0 percent coverage rather than a clean 0/0.
 */

const BREAKER_STATE_KEY = (orgId: string) => `burn:breaker:state:${orgId}`;
const BREAKER_PROBE_KEY = (orgId: string) => `burn:breaker:probe:${orgId}`;
const BREAKER_FAILS_KEY = (orgId: string) => `burn:breaker:fails:${orgId}`;
const GATE_CALLS_KEY = (orgId: string, day: string) => `burn:gate_calls:${orgId}:${day}`;
const GATE_UNAVAILABLE_KEY = (orgId: string, day: string) => `burn:gate_unavailable:${orgId}:${day}`;
const GATE_UNCONFIGURED_KEY = (orgId: string, day: string) => `burn:gate_unconfigured:${orgId}:${day}`;

const COVERAGE_TTL_SECONDS = 30 * 24 * 60 * 60;
const OPEN_STATE_TTL_MULTIPLIER = 20;

function utcDayStamp(now = new Date()): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
}

let client: Redis | null = null;
let connectAttempted = false;

/**
 * Lazy, non-throwing Redis. Mirrors the graceful-degradation shape of
 * apps/mcp-server/src/lib/confirm-token-store.ts: one connect attempt, and null forever
 * after if it fails, so a Redis outage costs one failed connect rather than one per call.
 */
async function getRedis(): Promise<Redis | null> {
  if (client) return client;
  if (connectAttempted) return null;
  connectAttempted = true;
  try {
    const env = loadEnv();
    const c = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    await c.connect();
    client = c;
    return c;
  } catch {
    return null;
  }
}

/** Never throws. Redis runs at --maxmemory noeviction, so writes error out at the cap. */
async function safe<T>(op: (r: Redis) => Promise<T>): Promise<T | null> {
  const r = await getRedis();
  if (!r) return null;
  try {
    return await op(r);
  } catch {
    return null;
  }
}

async function incrWithTtl(key: string): Promise<void> {
  const n = await safe((r) => r.incr(key));
  if (n !== null) await safe((r) => r.expire(key, COVERAGE_TTL_SECONDS));
}

export interface BurnRecurringGateConfig {
  baseUrl: string | undefined;
  timeoutMs: number;
  breakerThreshold: number;
  breakerProbeMs: number;
  internalSecret: string;
}

export function burnRecurringGateConfig(): BurnRecurringGateConfig {
  return {
    baseUrl: process.env.BURN_API_INTERNAL_URL || undefined,
    timeoutMs: Number(process.env.BURN_PRECHECK_TIMEOUT_MS ?? 800) || 800,
    breakerThreshold: Number(process.env.BURN_PRECHECK_BREAKER_THRESHOLD ?? 5) || 5,
    breakerProbeMs: Number(process.env.BURN_PRECHECK_BREAKER_PROBE_MS ?? 30000) || 30000,
    internalSecret: process.env.INTERNAL_SERVICE_SECRET ?? '',
  };
}

export interface RecurringChargeInput {
  organization_id: string;
  work_ref_id: string | null;
  project_id: string | null;
  proposed_amount: number;
  currency: string;
  title: string | null;
}

export interface JobGate {
  /**
   * Gate one generated invoice. Returns false ONLY on an enforced deny; true on every
   * error path, every non-deny verdict, and whenever the per-job breaker check already
   * decided the gate is not worth calling.
   */
  check(input: RecurringChargeInput): Promise<boolean>;
}

/**
 * Build the per-JOB gate. Call once at the top of a sweep; reuse for every schedule.
 * The breaker/config decision is memoized per org for the life of the returned object.
 */
export function createJobGate(logger: Logger): JobGate {
  const config = burnRecurringGateConfig();
  // org -> "may we call the gate at all this job?"
  const orgDecision = new Map<string, boolean>();

  async function breakerAllowsCalls(orgId: string): Promise<boolean> {
    const cached = orgDecision.get(orgId);
    if (cached !== undefined) return cached;

    let allow: boolean;
    if (!config.baseUrl) {
      allow = false;
    } else {
      const state = await safe((r) => r.get(BREAKER_STATE_KEY(orgId)));
      if (state !== 'open') {
        allow = true;
      } else {
        // Open. Take the same single-flight NX probe election bill-api uses, so a
        // recovering burn-api is probed by one caller per interval rather than by every
        // bill-api replica AND the worker simultaneously.
        const won = await safe((r) =>
          r.set(BREAKER_PROBE_KEY(orgId), String(Date.now()), 'PX', config.breakerProbeMs, 'NX'),
        );
        allow = won === 'OK';
        if (!allow) {
          logger.warn(
            { code: 'BURN_GATE_UNAVAILABLE', org_id: orgId, breaker_state: 'open' },
            'burn gate breaker open for this org, recurring sweep runs ungated for the whole job',
          );
        }
      }
    }
    orgDecision.set(orgId, allow);
    return allow;
  }

  return {
    async check(input: RecurringChargeInput): Promise<boolean> {
      const orgId = input.organization_id;
      const day = utcDayStamp();

      // Always count the attempt, before any other decision. See the header note: this is
      // what makes an unset BURN_API_INTERNAL_URL read as 0 percent coverage.
      await incrWithTtl(GATE_CALLS_KEY(orgId, day));

      if (!config.baseUrl) {
        await incrWithTtl(GATE_UNCONFIGURED_KEY(orgId, day));
        // Logged once per org per job, not once per schedule: 200 identical warn lines on
        // a daily sweep is noise that trains operators to ignore the code.
        if (!orgDecision.has(orgId)) {
          logger.warn(
            { code: 'BURN_GATE_NOT_CONFIGURED', org_id: orgId },
            'burn gate not configured: BURN_API_INTERNAL_URL is unset, recurring invoices generate ungated',
          );
        }
        orgDecision.set(orgId, false);
        return true;
      }

      if (!(await breakerAllowsCalls(orgId))) {
        await incrWithTtl(GATE_UNAVAILABLE_KEY(orgId, day));
        return true;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.internalSecret) headers['X-Internal-Secret'] = config.internalSecret;

        const res = await fetch(
          `${config.baseUrl.replace(/\/+$/, '')}/v1/internal/precheck`,
          {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
              organization_id: orgId,
              work_ref_type: 'bill.recurring',
              work_ref_id: input.work_ref_id,
              project_id: input.project_id,
              proposed_amount: input.proposed_amount,
              currency: input.currency,
              title: input.title,
              description: null,
              occurred_at: null,
              acting_user_id: null,
            }),
          },
        );

        if (res.status >= 500) {
          await recordFailure(orgId, config);
          await incrWithTtl(GATE_UNAVAILABLE_KEY(orgId, day));
          // Stop calling for the rest of this job: burn-api is unhealthy and the remaining
          // schedules would each pay the full timeout for the same answer.
          orgDecision.set(orgId, false);
          logger.warn(
            { code: 'BURN_GATE_UNAVAILABLE', org_id: orgId, status: res.status },
            'burn gate 5xx, remaining recurring invoices generate ungated',
          );
          return true;
        }

        if (!res.ok) {
          // 4xx (including burn-api's own 429) fails open but does NOT trip the breaker and
          // is NOT a burn-api health signal (spec 5.6: 429s never count toward coverage
          // loss). Still counted as unavailable-for-this-charge so coverage is honest.
          await incrWithTtl(GATE_UNAVAILABLE_KEY(orgId, day));
          return true;
        }

        const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
        const verdict = (body.data ?? body) as { verdict?: string; enforced?: boolean };

        // Success clears the breaker for everyone, including bill-api's replicas.
        await safe((r) =>
          r.del(BREAKER_FAILS_KEY(orgId), BREAKER_STATE_KEY(orgId), BREAKER_PROBE_KEY(orgId)),
        );

        return !(verdict.verdict === 'deny' && verdict.enforced === true);
      } catch (err) {
        await recordFailure(orgId, config);
        await incrWithTtl(GATE_UNAVAILABLE_KEY(orgId, day));
        orgDecision.set(orgId, false);
        logger.warn(
          {
            code: 'BURN_GATE_UNAVAILABLE',
            org_id: orgId,
            err: err instanceof Error ? err.message : String(err),
          },
          'burn gate unreachable, remaining recurring invoices generate ungated',
        );
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Shared atomic INCR, so the worker's failures and bill-api's count toward one threshold. */
async function recordFailure(orgId: string, config: BurnRecurringGateConfig): Promise<void> {
  const fails = await safe((r) => r.incr(BREAKER_FAILS_KEY(orgId)));
  if (fails === null) return;
  await safe((r) => r.expire(BREAKER_FAILS_KEY(orgId), Math.ceil((config.breakerProbeMs * 4) / 1000)));
  if (fails < config.breakerThreshold) return;
  await safe((r) =>
    r.set(
      BREAKER_STATE_KEY(orgId),
      'open',
      'PX',
      config.breakerProbeMs * OPEN_STATE_TTL_MULTIPLIER,
    ),
  );
  await safe((r) => r.del(BREAKER_FAILS_KEY(orgId)));
}
