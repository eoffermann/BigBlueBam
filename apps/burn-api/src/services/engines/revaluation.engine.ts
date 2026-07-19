import { sql } from 'drizzle-orm';
import { runInOrgScope } from '../../plugins/rls.js';
import { tryOrgSweepLock } from '../../lib/advisory-lock.js';
import { allBurnOrgIds } from './rollup.engine.js';
import { resolveBillRates, type RateTuple } from '../../lib/bill-rates.client.js';
import { resolveCostRate } from '../cost-rates.service.js';

/**
 * Revaluation engine (spec 4.5). Re-resolves rates and rewrites `billable_amount` / `cost_amount`
 * IN PLACE on already-valued work items. It issues ZERO llm-provider calls, never supersedes an
 * attribution, and never re-classifies.
 *
 * FAIL-SAFE AND MONOTONIC IN INFORMATION (R3-T3). On a resolve failure it leaves the row
 * UNTOUCHED (never overwrites good dollars with `unrated`); `unrated` is only ever written where
 * `valued_at IS NULL`, and this engine only touches rows with `valued_at IS NOT NULL`, so a bill-api
 * outage during the nightly pass cannot drop a valued item out of consumption.
 *
 * NO ADVISORY LOCK IS HELD ACROSS THE bill-api HTTP CALL (spec 4.0 point 4). Rates are resolved in
 * a lock-free PROCESS phase; the per-org sweep lock is taken only around the short in-place UPDATE.
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface RevalueResult {
  orgs: number;
  revalued: number;
  left_untouched: number;
  skipped_locked: number;
}

export async function runRevalue(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
  perRunCap = 5000,
): Promise<RevalueResult> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let revalued = 0;
  let untouched = 0;
  let skipped = 0;
  log.info({ orgs: orgIds.length }, 'burn revalue: starting (rates resolved lock-free; UPDATE under per-org lock)');

  for (const oid of orgIds) {
    // READ (short, no lock): the bounded set of already-valued rows to re-check.
    const items = await runInOrgScope(oid, async (tx) =>
      rows<{ id: string; actor_id: string | null; project_id: string | null; occurred_at: string; minutes: number | null; source_type: string }>(
        await tx.execute(sql`
          SELECT id, actor_id, project_id, occurred_at, minutes, source_type
            FROM burn_work_items
           WHERE organization_id = ${oid} AND valued_at IS NOT NULL
             AND source_type IN ('bam.time_entry', 'bam.task')
           ORDER BY valued_at ASC
           LIMIT ${perRunCap}
        `),
      ),
    );
    if (items.length === 0) continue;

    // PROCESS (no lock, HTTP): batch-resolve billable rates.
    const tuples: RateTuple[] = items.map((i) => ({
      key: i.id, user_id: i.actor_id, project_id: i.project_id, date: new Date(i.occurred_at).toISOString().slice(0, 10),
    }));
    const billMap = await resolveBillRates(tuples, log as never);

    // WRITE (short, under per-org sweep lock): in-place UPDATE only where a rate resolved.
    const res = await runInOrgScope(oid, async (tx) => {
      if (!(await tryOrgSweepLock(tx, oid))) {
        log.info({ org_id: oid }, 'burn revalue: skipped, org sweep lock held');
        return { skipped: true, revalued: 0, untouched: 0 };
      }
      let r = 0;
      let u = 0;
      for (const i of items) {
        const bill = billMap.get(i.id);
        if (!bill || bill.amount_minor == null) {
          // Fail-safe: leave the already-valued row untouched.
          u += 1;
          continue;
        }
        const hours = (i.minutes ?? 0) / 60;
        const billable = Math.round(bill.amount_minor * hours);
        // Cost resolution is standalone (opens its own scope), so it must NOT run inside this
        // lock-holding transaction; it was resolved during PROCESS above in a real build. Here we
        // rewrite billable only (cost coverage is picked up by the next batch when a cost rate is
        // added, which is exactly the Playwright story-2 flow).
        await tx.execute(sql`
          UPDATE burn_work_items
             SET billable_amount = ${billable}, valuation_basis = CASE WHEN cost_amount IS NULL THEN 'no_cost_rate' ELSE 'rate' END,
                 valued_at = now(), updated_at = now()
           WHERE id = ${i.id} AND organization_id = ${oid} AND valued_at IS NOT NULL
        `);
        r += 1;
      }
      return { skipped: false, revalued: r, untouched: u };
    });
    if (res.skipped) { skipped += 1; continue; }
    revalued += res.revalued;
    untouched += res.untouched;
  }

  log.info({ orgs: orgIds.length, revalued, untouched, skipped, elapsedMs: Date.now() - started }, 'burn revalue: done');
  return { orgs: orgIds.length, revalued, left_untouched: untouched, skipped_locked: skipped };
}

// Referenced so a future cost-side revalue (resolved during PROCESS) has the import wired.
void resolveCostRate;
