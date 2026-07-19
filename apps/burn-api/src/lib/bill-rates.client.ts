import { env } from '../env.js';

/**
 * Billable-rate resolution against bill-api (spec 2.3.1.2 / 4.5). Burn has no billable-rate
 * store of its own; it delegates to bill-api's `POST /internal/rates/resolve`, which applies the
 * `user+project > user > project > org` precedence with inclusive `effective_to` (the parity
 * test in 12.1 pins Burn's cost resolver and this call to the same result).
 *
 * FAIL-SAFE (spec 4.5, R2-I5). Any non-2xx / transport / timeout returns null for the affected
 * tuple. The valuation engines translate a null into `valuation_basis='unrated'` /
 * `unrated_reason='rate_service_unavailable'` ONLY on a first valuation (a row with
 * `valued_at IS NULL`); `burn-revalue` leaves an already-valued row untouched. bill-api's
 * `/internal/rates/resolve` batch form is added by the M6b bill-api slice; until then this
 * degrades cleanly (a 404 reads as "no rate resolved"), which is also the exact condition the
 * revalue fail-safe test exercises.
 */

export interface RateTuple {
  key: string; // caller-chosen correlation key (e.g. work_item id)
  user_id: string | null;
  project_id: string | null;
  date: string; // ISO date (occurred_at day)
}

export interface ResolvedRate {
  key: string;
  rate_id: string | null;
  amount_minor: number | null; // per-hour minor units
  currency: string | null;
}

function billBase(): string {
  return (env.BILL_API_INTERNAL_URL ?? '').replace(/\/+$/, '');
}

/**
 * Batch-resolve billable rates. Returns a Map keyed by the tuple `key`. A tuple that could not
 * be resolved (or the whole call failing) yields no entry, which the caller reads as "unrated".
 * Never throws.
 */
export async function resolveBillRates(
  tuples: RateTuple[],
  log?: { debug?: (o: unknown, m?: string) => void },
): Promise<Map<string, ResolvedRate>> {
  const out = new Map<string, ResolvedRate>();
  const base = billBase();
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret || tuples.length === 0) return out;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/internal/rates/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({ tuples }),
    });
    if (!res.ok) {
      log?.debug?.({ status: res.status }, 'bill rate resolve non-2xx; degrading to unrated');
      return out;
    }
    const body = (await res.json().catch(() => null)) as { data?: { rates?: ResolvedRate[] } } | null;
    for (const r of body?.data?.rates ?? []) {
      if (r && typeof r.key === 'string') out.set(r.key, r);
    }
    return out;
  } catch (err) {
    log?.debug?.({ err }, 'bill rate resolve failed; degrading to unrated');
    return out;
  } finally {
    clearTimeout(timer);
  }
}
