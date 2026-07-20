import { sql } from 'drizzle-orm';
import { runInOrgScope } from '../../plugins/rls.js';
import { tryOrgSweepLock } from '../../lib/advisory-lock.js';
import { allBurnOrgIds, computeChainRollup } from './rollup.engine.js';

/**
 * Retention engine (spec 8.1, R3-T5). Per org, per-org sweep lock. For a CLOSED chain, in ONE
 * transaction and IN THIS ORDER:
 *   1. recompute the rollup to final (the exact figure),
 *   2. set `frozen_at` + `margin_state='final'` as an UPSERT (a missing row is CREATED, not
 *      skipped, so a closed chain with no rollup does not later compute $0 as its permanent record),
 *   3. THEN purge the work items.
 * §12.1 asserts the frozen figure equals the PRE-PURGE computed figure. Work items whose chain is
 * not closed are exempt. Never purged: enforced/overridden/labeled/superseded prechecks,
 * burn_classifier_feedback, burn_extraction_runs.
 */

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface RetentionResult {
  orgs: number;
  chains_frozen: number;
  work_items_purged: number;
  ingest_events_purged: number;
  prechecks_purged: number;
  skipped_locked: number;
}

/** Bounded delete chunk so a single sweep never issues one unbounded DELETE. */
const PURGE_CHUNK = 5000;

/**
 * Purge TERMINAL ingest events (`processed` / `skipped`) older than `ingest_retention_days`
 * (#98). This is the disk-full class: processed inbox rows were never purged, so the table
 * grew without bound. Pending/claimed rows are NEVER touched - they are still owed work. The
 * delete is chunked with flushed per-pass progress logging.
 */
async function purgeProcessedIngestEvents(
  oid: string,
  retentionDays: number,
  log: { info: (o: unknown, m?: string) => void },
): Promise<number> {
  let total = 0;
  for (;;) {
    const del = await runInOrgScope(oid, async (tx) =>
      rows<{ id: string }>(
        await tx.execute(sql`
          DELETE FROM burn_ingest_events
           WHERE id IN (
             SELECT id FROM burn_ingest_events
              WHERE organization_id = ${oid}
                AND status IN ('processed', 'skipped')
                AND COALESCE(processed_at, received_at) < now() - (${retentionDays}::text || ' days')::interval
              ORDER BY received_at ASC
              LIMIT ${PURGE_CHUNK}
           )
          RETURNING id
        `),
      ),
    );
    total += del.length;
    if (del.length > 0) {
      log.info(
        { org_id: oid, purged_this_pass: del.length, ingest_events_purged: total },
        'burn retention: ingest-event purge progress',
      );
    }
    if (del.length < PURGE_CHUNK) break;
  }
  return total;
}

/**
 * Purge expired prechecks older than the retention horizon (#98). Burn has no dedicated
 * `precheck_retention_days` setting (the spec names none), so prechecks reuse
 * `ingest_retention_days`. NEVER purged (spec 8.1): enforced, overridden, labeled
 * (advisory_feedback set), or superseded rows - each is part of the dispute / calibration
 * record. Chunked with flushed progress logging.
 */
async function purgeExpiredPrechecks(
  oid: string,
  retentionDays: number,
  log: { info: (o: unknown, m?: string) => void },
): Promise<number> {
  let total = 0;
  for (;;) {
    const del = await runInOrgScope(oid, async (tx) =>
      rows<{ id: string }>(
        await tx.execute(sql`
          DELETE FROM burn_prechecks
           WHERE id IN (
             SELECT id FROM burn_prechecks
              WHERE organization_id = ${oid}
                AND created_at < now() - (${retentionDays}::text || ' days')::interval
                AND enforced = false
                AND override_reason_code IS NULL
                AND overridden_at IS NULL
                AND advisory_feedback IS NULL
                AND superseded_at IS NULL
              ORDER BY created_at ASC
              LIMIT ${PURGE_CHUNK}
           )
          RETURNING id
        `),
      ),
    );
    total += del.length;
    if (del.length > 0) {
      log.info(
        { org_id: oid, purged_this_pass: del.length, prechecks_purged: total },
        'burn retention: precheck purge progress',
      );
    }
    if (del.length < PURGE_CHUNK) break;
  }
  return total;
}

/** Per-org retention settings, with the shipped defaults when no settings row exists yet. */
async function loadRetentionSettings(oid: string): Promise<{ ingest_retention_days: number }> {
  const s = rows<{ ingest_retention_days: number }>(
    await (await import('../../db/index.js')).db.execute(
      sql`SELECT ingest_retention_days FROM burn_org_settings WHERE organization_id = ${oid}`,
    ),
  )[0];
  return { ingest_retention_days: Number(s?.ingest_retention_days ?? 400) };
}

export async function runRetention(
  orgId: string | null,
  log: { info: (o: unknown, m?: string) => void },
): Promise<RetentionResult> {
  const started = Date.now();
  const orgIds = orgId ? [orgId] : await allBurnOrgIds();
  let frozen = 0;
  let purged = 0;
  let ingestPurged = 0;
  let prechecksPurged = 0;
  let skipped = 0;
  log.info(
    { orgs: orgIds.length },
    'burn retention: starting (freeze closed chains, then purge terminal ingest events + expired prechecks)',
  );

  for (const oid of orgIds) {
    // Closed chains eligible for freeze+purge, EXCLUDING any chain whose rollup is already
    // frozen (R2-T5 / #94). A frozen rollup is the immutable final record and its work items
    // were already purged in the same transaction that froze it, so re-selecting it on a
    // later nightly run would recompute over the purged rows and overwrite the correct final
    // figures with zeros. A frozen chain is done: skip it entirely.
    const closedChains = await runInOrgScope(oid, async (tx) =>
      rows<{ chain_root_id: string }>(
        await tx.execute(sql`
          SELECT DISTINCT e.chain_root_id FROM burn_engagements e
           WHERE e.organization_id = ${oid} AND e.status = 'closed'
             AND NOT EXISTS (
               SELECT 1 FROM burn_engagement_rollups r
                WHERE r.organization_id = ${oid}
                  AND r.chain_root_id = e.chain_root_id
                  AND r.frozen_at IS NOT NULL
             )
        `),
      ),
    );

    for (const c of closedChains) {
      const res = await runInOrgScope(oid, async (tx) => {
        if (!(await tryOrgSweepLock(tx, oid))) return { skipped: true, purged: 0 };
        // 1. recompute to final (pre-purge figure).
        const computed = await computeChainRollup(tx, oid, c.chain_root_id);
        // 2. freeze upsert (creates a missing row; NEVER overwrites an already-frozen row -
        //    the DO UPDATE carries the `frozen_at IS NULL` guard, mirroring rollup.engine.ts,
        //    so even if a concurrent freeze slipped in after the closed-chain select above the
        //    final figures stay immutable).
        await tx.execute(sql`
          INSERT INTO burn_engagement_rollups (
            organization_id, chain_root_id, contract_value, attributed_billable, attributed_cost,
            unscoped_sold_by_nobody, unscoped_unclassified, unscoped_outside_contract,
            pending_review_amount, awaiting_valuation_amount, non_billable_amount, consumption_pct,
            margin_amount, margin_pct, cost_rate_coverage_pct, priced_deliverable_coverage_pct,
            distinct_contributor_count, metric_basis, revenue_basis, margin_state, work_item_count,
            frozen_at, computed_at
          ) VALUES (
            ${oid}, ${computed.chain_root_id}, ${computed.contract_value}, ${computed.attributed_billable}, ${computed.attributed_cost},
            ${computed.unscoped_sold_by_nobody}, ${computed.unscoped_unclassified}, ${computed.unscoped_outside_contract},
            ${computed.pending_review_amount}, ${computed.awaiting_valuation_amount}, ${computed.non_billable_amount}, ${computed.consumption_pct},
            ${computed.margin_amount}, ${computed.margin_pct}, ${computed.cost_rate_coverage_pct}, ${computed.priced_deliverable_coverage_pct},
            ${computed.distinct_contributor_count}, ${computed.metric_basis}, ${computed.revenue_basis}, 'final', ${computed.work_item_count},
            now(), now()
          )
          ON CONFLICT (organization_id, chain_root_id) DO UPDATE SET
            contract_value = EXCLUDED.contract_value, attributed_billable = EXCLUDED.attributed_billable,
            attributed_cost = EXCLUDED.attributed_cost, margin_amount = EXCLUDED.margin_amount,
            margin_pct = EXCLUDED.margin_pct, consumption_pct = EXCLUDED.consumption_pct,
            margin_state = 'final', frozen_at = COALESCE(burn_engagement_rollups.frozen_at, now()), computed_at = now()
          WHERE burn_engagement_rollups.frozen_at IS NULL
        `);
        // 3. purge work items for this closed chain (attributions cascade via FK).
        const del = rows<{ id: string }>(
          await tx.execute(sql`
            DELETE FROM burn_work_items
             WHERE organization_id = ${oid}
               AND id IN (
                 SELECT wi.id FROM burn_work_items wi
                   JOIN burn_attributions a ON a.work_item_id = wi.id
                  WHERE wi.organization_id = ${oid} AND a.chain_root_id = ${c.chain_root_id}
               )
            RETURNING id
          `),
        );
        return { skipped: false, purged: del.length };
      });
      if (res.skipped) { skipped += 1; continue; }
      frozen += 1;
      purged += res.purged;
    }

    // Volume retention (#98): wire the previously-dead `ingest_retention_days` setting.
    // Processed inbox rows and expired non-durable prechecks are the disk-full class; both
    // are purged in bounded chunks with flushed progress logging. These deletes are
    // time-based on terminal rows, so they run outside the per-chain sweep lock.
    const settings = await loadRetentionSettings(oid);
    ingestPurged += await purgeProcessedIngestEvents(oid, settings.ingest_retention_days, log);
    prechecksPurged += await purgeExpiredPrechecks(oid, settings.ingest_retention_days, log);
  }

  log.info(
    {
      orgs: orgIds.length,
      frozen,
      work_items_purged: purged,
      ingest_events_purged: ingestPurged,
      prechecks_purged: prechecksPurged,
      skipped,
      elapsedMs: Date.now() - started,
    },
    'burn retention: done',
  );
  return {
    orgs: orgIds.length,
    chains_frozen: frozen,
    work_items_purged: purged,
    ingest_events_purged: ingestPurged,
    prechecks_purged: prechecksPurged,
    skipped_locked: skipped,
  };
}
