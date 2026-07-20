import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { runInOrgScope } from '../../plugins/rls.js';
import { db } from '../../db/index.js';
import type { DbTx } from '../../db/index.js';
import {
  selectAwardForSpend,
  matchSpendLine,
  evaluatePriceDrift,
  invoicedScopeDivergence,
  silentLineDivergence,
  detectUnbaselinedVendors,
  type BaselineLine,
  type AwardTerm,
  type SpendLine,
} from './detectors-logic.js';
import {
  upsertFinding,
  mismatchDedupKey,
  evidenceHash,
  detectorCountToday,
  recordDetectorCapped,
  DEFAULT_DETECTOR_DAILY_CAP,
  type FindingInput,
} from './mismatch-store.js';

/**
 * The bursar-drift-sweep engine (spec 7.3, 8, 15, M8). A BOUNDED, resumable sweep:
 *   - an org cursor across ticks (orgs holding un-evaluated spend);
 *   - a per-tick row budget per org;
 *   - ROW CLAIMS WITH LEASE RENEWAL (drift_claimed_at/by fence two workers);
 *   - progress logging (org n/N, rows n/N, elapsed-ms) BEFORE each stall, flushed by pino;
 *   - a per-org ADVISORY LOCK shared with reconcile (so the two never flap; reconcile is offset
 *     to :05/:35 to run after a sweep tick).
 *
 * Detectors 1-3 run here (price_drift, scope_divergence incl. silent lines, unbaselined_vendor);
 * detector 4 (renewal_cliff) is the separate renewal radar. Currency is a hard precondition and
 * dollars at stake are computed, never estimated (enforced in detectors-logic.ts).
 */

export interface DriftSweepSummary {
  orgs: number;
  spend_evaluated: number;
  findings_opened: number;
  findings_updated: number;
}

export interface DriftSweepBudgets {
  orgBudget: number;
  rowBudget: number;
  leaseMs: number;
}

export const DEFAULT_DRIFT_BUDGETS: DriftSweepBudgets = { orgBudget: 25, rowBudget: 500, leaseMs: 5 * 60 * 1000 };

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The per-org advisory lock key class, SHARED by drift-sweep and mismatch-reconcile (spec 15). */
export function bursarSweepLockKey(orgId: string): ReturnType<typeof sql> {
  return sql`hashtext(${`bursar:sweep:${orgId}`})`;
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** Orgs holding un-evaluated spend, oldest-first, bounded by the org budget (the cursor). */
async function orgsWithPendingSpend(orgBudget: number): Promise<string[]> {
  const raw = await db.execute(sql`
    SELECT organization_id, min(occurred_on) AS oldest
      FROM bursar_spend_events
     WHERE drift_evaluated_at IS NULL
     GROUP BY organization_id
     ORDER BY oldest ASC
     LIMIT ${orgBudget}
  `);
  return pgRows<{ organization_id: string }>(raw).map((r) => r.organization_id);
}

export async function runDriftSweep(
  logger: Logger,
  orgId: string | undefined,
  budgets: DriftSweepBudgets = DEFAULT_DRIFT_BUDGETS,
): Promise<DriftSweepSummary> {
  const started = Date.now();
  const orgs = orgId ? [orgId] : await orgsWithPendingSpend(budgets.orgBudget);
  const summary: DriftSweepSummary = { orgs: orgs.length, spend_evaluated: 0, findings_opened: 0, findings_updated: 0 };
  let i = 0;
  for (const org of orgs) {
    i += 1;
    logger.info({ org, orgIdx: `${i}/${orgs.length}`, elapsedMs: Date.now() - started }, 'bursar-drift-sweep: org start');
    const s = await sweepOneOrg(logger, org, budgets, started, `${i}/${orgs.length}`);
    summary.spend_evaluated += s.spend_evaluated;
    summary.findings_opened += s.findings_opened;
    summary.findings_updated += s.findings_updated;
  }
  logger.info({ ...summary, elapsedMs: Date.now() - started }, 'bursar-drift-sweep: complete');
  return summary;
}

async function sweepOneOrg(
  logger: Logger,
  orgId: string,
  budgets: DriftSweepBudgets,
  started: number,
  orgIdx: string,
): Promise<Omit<DriftSweepSummary, 'orgs'>> {
  return runInOrgScope(orgId, async (tx) => {
    // Per-org advisory lock (shared class with reconcile). Non-blocking: if reconcile holds it,
    // skip this org this tick; the next tick picks it up.
    const got = pgRows<{ locked: boolean }>(
      await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${bursarSweepLockKey(orgId)}) AS locked`),
    )[0]?.locked;
    if (!got) {
      logger.warn({ orgId, orgIdx }, 'bursar-drift-sweep: org lock busy; deferring to next tick');
      return { spend_evaluated: 0, findings_opened: 0, findings_updated: 0 };
    }

    // Claim a budget of un-evaluated spend rows with a lease (fences a second worker even though the
    // advisory lock already serializes; the lease is the durable half if the tx is long).
    const claimant = `sweep:${orgId}:${Date.now()}`;
    const claimed = pgRows<SpendRow>(
      await tx.execute(sql`
        UPDATE bursar_spend_events
           SET drift_claimed_at = now(), drift_claimed_by = ${claimant}
         WHERE id IN (
           SELECT id FROM bursar_spend_events
            WHERE organization_id = ${orgId} AND drift_evaluated_at IS NULL
            ORDER BY occurred_on ASC, id ASC
            LIMIT ${budgets.rowBudget}
            FOR UPDATE SKIP LOCKED
         )
        RETURNING id, vendor_id, normalized_payee, payee_raw, occurred_on::text AS occurred_on, amount_minor, currency
      `),
    );

    logger.info(
      { orgId, orgIdx, claimed: claimed.length, elapsedMs: Date.now() - started },
      'bursar-drift-sweep: rows claimed; evaluating',
    );

    const caps = new Map<string, number>();
    const capReached = new Set<string>();
    let opened = 0;
    let updated = 0;

    // Load the org's active awards + their included baseline items once.
    const awardsByVendor = await loadActiveAwards(tx, orgId);

    let n = 0;
    for (const row of claimed) {
      n += 1;
      if (n % 100 === 0) {
        logger.info({ orgId, orgIdx, rows: `${n}/${claimed.length}`, elapsedMs: Date.now() - started }, 'bursar-drift-sweep: progress');
      }
      const vendorAwards = row.vendor_id ? awardsByVendor.get(row.vendor_id) : undefined;
      if (vendorAwards && vendorAwards.awards.length > 0) {
        const sel = selectAwardForSpend(vendorAwards.awards, row.occurred_on);
        if (sel) {
          const items = vendorAwards.baselineByAward.get(sel.award.id) ?? [];
          const spend: SpendLine = {
            id: row.id,
            normalized_payee: row.normalized_payee,
            vendor_id: row.vendor_id,
            occurred_on: row.occurred_on,
            amount_minor: row.amount_minor,
            currency: row.currency,
          };
          const match = matchSpendLine(spend, row.payee_raw ?? row.normalized_payee, items);
          if (match) {
            // Pin the match on the spend row so silent-line detection knows it was seen.
            await tx.execute(sql`
              UPDATE bursar_spend_events SET matched_baseline_item_id = ${match.baseline.id}, match_method = ${match.method}
               WHERE organization_id = ${orgId} AND id = ${row.id}
            `);
            const drift = evaluatePriceDrift(spend, match.baseline);
            if (drift.result === 'drift') {
              const r = await recordFinding(tx, orgId, caps, capReached, {
                detector: 'price_drift',
                severity: severityForDollars(drift.dollars_at_stake_minor),
                subjectKey: `${row.id}:${match.baseline.id}`,
                evidence: { observed: drift.observed_minor, expected: drift.expected_minor, pct: drift.deviation_pct },
                finding: {
                  detector: 'price_drift',
                  severity: severityForDollars(drift.dollars_at_stake_minor),
                  dedup_key: '',
                  evidence_hash: '',
                  vendor_id: row.vendor_id,
                  award_id: sel.award.id,
                  chain_root_id: vendorAwards.chainRootByAward.get(sel.award.id) ?? null,
                  baseline_item_id: match.baseline.id,
                  spend_event_id: row.id,
                  normalized_payee: row.normalized_payee,
                  dollars_at_stake_minor: drift.dollars_at_stake_minor,
                  currency: drift.currency,
                  cited_span: { baseline_item_id: match.baseline.id, title: match.baseline.title },
                  details: {
                    metric: 'unit_price',
                    observed_minor: drift.observed_minor,
                    expected_minor: drift.expected_minor,
                    deviation_pct: drift.deviation_pct,
                    match_method: match.method,
                    award_match_method: sel.match_method,
                  },
                },
              });
              if (r === 'insert') opened += 1;
              else if (r === 'update') updated += 1;
            } else if (drift.result === 'skip') {
              // currency_mismatch: record the skip as a low finding, do NOT compute price drift.
              const r = await recordFinding(tx, orgId, caps, capReached, {
                detector: 'currency_mismatch',
                severity: 'low',
                subjectKey: `${row.id}:${match.baseline.id}`,
                evidence: { observed_currency: drift.observed_currency, baseline_currency: drift.baseline_currency },
                finding: {
                  detector: 'currency_mismatch',
                  severity: 'low',
                  dedup_key: '',
                  evidence_hash: '',
                  vendor_id: row.vendor_id,
                  award_id: sel.award.id,
                  baseline_item_id: match.baseline.id,
                  spend_event_id: row.id,
                  normalized_payee: row.normalized_payee,
                  dollars_at_stake_minor: null,
                  currency: drift.observed_currency,
                  basis: 'currency_mismatch',
                  details: { observed_currency: drift.observed_currency, baseline_currency: drift.baseline_currency },
                },
              });
              if (r === 'insert') opened += 1;
              else if (r === 'update') updated += 1;
            }
          } else {
            // Invoiced line with no baseline item under an awarded vendor: scope divergence.
            const f = invoicedScopeDivergence(spend);
            const r = await recordFinding(tx, orgId, caps, capReached, {
              detector: 'scope_divergence',
              severity: severityForDollars(f.dollars_at_stake_minor),
              subjectKey: `${row.id}`,
              evidence: { amount: f.dollars_at_stake_minor, kind: f.kind },
              finding: {
                detector: 'scope_divergence',
                severity: severityForDollars(f.dollars_at_stake_minor),
                dedup_key: '',
                evidence_hash: '',
                vendor_id: row.vendor_id,
                award_id: sel.award.id,
                chain_root_id: vendorAwards.chainRootByAward.get(sel.award.id) ?? null,
                spend_event_id: row.id,
                normalized_payee: row.normalized_payee,
                dollars_at_stake_minor: f.dollars_at_stake_minor,
                currency: f.currency,
                basis: 'invoiced_unbaselined',
                details: { kind: f.kind },
              },
            });
            if (r === 'insert') opened += 1;
            else if (r === 'update') updated += 1;
          }
        }
      }
      // Stamp evaluated (both the awarded and the award-less cases; award-less feeds the unbaselined
      // aggregate pass below, but the row is not re-claimed).
      await tx.execute(sql`
        UPDATE bursar_spend_events SET drift_evaluated_at = now(), drift_claimed_at = NULL, drift_claimed_by = NULL
         WHERE organization_id = ${orgId} AND id = ${row.id}
      `);
    }

    // Detector 3: unbaselined_vendor over the trailing 180d, award-less spend grouped by
    // normalized_payee (the shadow-IT bucket). Recomputed each sweep; idempotent by payee dedup key.
    const unbaselinedOpened = await runUnbaselinedPass(tx, orgId, caps, capReached, started, logger);
    opened += unbaselinedOpened.opened;
    updated += unbaselinedOpened.updated;

    // Silent-line divergence: included baseline items on an evaluable award with no matched spend.
    const silent = await runSilentLinePass(tx, orgId, awardsByVendor, caps, capReached);
    opened += silent.opened;
    updated += silent.updated;

    return { spend_evaluated: claimed.length, findings_opened: opened, findings_updated: updated };
  });
}

interface SpendRow {
  id: string;
  vendor_id: string | null;
  normalized_payee: string | null;
  payee_raw: string | null;
  occurred_on: string;
  amount_minor: number;
  currency: string;
}

interface VendorAwards {
  awards: AwardTerm[];
  baselineByAward: Map<string, BaselineLine[]>;
  chainRootByAward: Map<string, string | null>;
}

async function loadActiveAwards(tx: DbTx, orgId: string): Promise<Map<string, VendorAwards>> {
  const awardRows = pgRows<{
    id: string;
    vendor_id: string | null;
    chain_root_id: string | null;
    term_start: string | null;
    term_end: string | null;
    awarded_at: string;
    currency: string;
  }>(
    await tx.execute(sql`
      SELECT id, vendor_id, chain_root_id, term_start::text AS term_start, term_end::text AS term_end,
             awarded_at::text AS awarded_at, currency
        FROM bursar_awards
       WHERE organization_id = ${orgId} AND status = 'active' AND vendor_id IS NOT NULL
    `),
  );
  const byVendor = new Map<string, VendorAwards>();
  for (const a of awardRows) {
    if (!a.vendor_id) continue;
    const va: VendorAwards = byVendor.get(a.vendor_id) ?? { awards: [], baselineByAward: new Map(), chainRootByAward: new Map() };
    va.awards.push({ id: a.id, term_start: a.term_start, term_end: a.term_end, awarded_at: a.awarded_at, currency: a.currency });
    va.chainRootByAward.set(a.id, a.chain_root_id);
    byVendor.set(a.vendor_id, va);
  }
  // Load included baseline items for those awards.
  for (const [, va] of byVendor) {
    for (const award of va.awards) {
      const items = pgRows<BaselineLine>(
        await tx.execute(sql`
          SELECT id, award_id, title, kind, currency, unit_price_minor, quantity::text AS quantity, extended_minor
            FROM bursar_baseline_items
           WHERE organization_id = ${orgId} AND award_id = ${award.id} AND kind = 'included'
        `),
      );
      va.baselineByAward.set(award.id, items);
    }
  }
  return byVendor;
}

async function runUnbaselinedPass(
  tx: DbTx,
  orgId: string,
  caps: Map<string, number>,
  capReached: Set<string>,
  started: number,
  logger: Logger,
): Promise<{ opened: number; updated: number }> {
  // Award-less spend in the trailing window: vendor has no active award (or vendor_id NULL).
  const events = pgRows<SpendLine>(
    await tx.execute(sql`
      SELECT se.id, se.normalized_payee, se.vendor_id, se.occurred_on::text AS occurred_on, se.amount_minor, se.currency
        FROM bursar_spend_events se
       WHERE se.organization_id = ${orgId}
         AND se.occurred_on >= (now()::date - INTERVAL '180 days')
         AND NOT EXISTS (
           SELECT 1 FROM bursar_awards a
            WHERE a.organization_id = se.organization_id AND a.vendor_id = se.vendor_id AND a.status = 'active'
         )
    `),
  );
  const today = new Date().toISOString().slice(0, 10);
  const findings = detectUnbaselinedVendors(events, today);
  logger.info({ orgId, shadow_payees: findings.length, elapsedMs: Date.now() - started }, 'bursar-drift-sweep: unbaselined pass');
  let opened = 0;
  let updated = 0;
  for (const f of findings) {
    const r = await recordFinding(tx, orgId, caps, capReached, {
      detector: 'unbaselined_vendor',
      severity: severityForDollars(f.dollars_at_stake_minor),
      subjectKey: `payee:${f.normalized_payee}`,
      evidence: { count: f.event_count, spend: f.dollars_at_stake_minor, last: f.last_occurred_on },
      finding: {
        detector: 'unbaselined_vendor',
        severity: severityForDollars(f.dollars_at_stake_minor),
        dedup_key: '',
        evidence_hash: '',
        normalized_payee: f.normalized_payee,
        dollars_at_stake_minor: f.dollars_at_stake_minor,
        currency: f.currency,
        details: {
          event_count: f.event_count,
          window_days: 180,
          first_occurred_on: f.first_occurred_on,
          last_occurred_on: f.last_occurred_on,
        },
      },
    });
    if (r === 'insert') opened += 1;
    else if (r === 'update') updated += 1;
  }
  return { opened, updated };
}

async function runSilentLinePass(
  tx: DbTx,
  orgId: string,
  awardsByVendor: Map<string, VendorAwards>,
  caps: Map<string, number>,
  capReached: Set<string>,
): Promise<{ opened: number; updated: number }> {
  const today = new Date().toISOString().slice(0, 10);
  let opened = 0;
  let updated = 0;
  for (const [, va] of awardsByVendor) {
    for (const award of va.awards) {
      const items = va.baselineByAward.get(award.id) ?? [];
      for (const item of items) {
        const div = silentLineDivergence(item, award, today);
        if (!div) continue; // award window not yet evaluable
        // Silent only if NO spend matched this baseline item.
        const seen = pgRows<{ n: number }>(
          await tx.execute(sql`
            SELECT count(*)::int AS n FROM bursar_spend_events
             WHERE organization_id = ${orgId} AND matched_baseline_item_id = ${item.id}
          `),
        )[0]?.n ?? 0;
        if (seen > 0) continue;
        const r = await recordFinding(tx, orgId, caps, capReached, {
          detector: 'scope_divergence',
          severity: 'medium',
          subjectKey: `silent:${item.id}`,
          evidence: { basis: div.basis, item: item.id },
          finding: {
            detector: 'scope_divergence',
            severity: 'medium',
            dedup_key: '',
            evidence_hash: '',
            award_id: award.id,
            chain_root_id: va.chainRootByAward.get(award.id) ?? null,
            baseline_item_id: item.id,
            dollars_at_stake_minor: div.dollars_at_stake_minor, // null: "not quantified"
            currency: div.currency,
            basis: div.basis,
            details: { kind: 'silent_line', basis: div.basis, title: item.title },
          },
        });
        if (r === 'insert') opened += 1;
        else if (r === 'update') updated += 1;
      }
    }
  }
  return { opened, updated };
}

/** Map computed dollars-at-stake to a coarse severity band. Null (unquantified) -> medium. */
function severityForDollars(minor: number | null): string {
  if (minor === null) return 'medium';
  const abs = Math.abs(minor);
  if (abs >= 5_000_00) return 'critical';
  if (abs >= 1_000_00) return 'high';
  if (abs >= 100_00) return 'medium';
  return 'low';
}

type RecordOutcome = 'insert' | 'update' | 'capped';

/**
 * Apply the daily cap, then upsert the finding. The cap count is seeded once per (detector) from the
 * DB and incremented in-memory across the tick; the first row over the cap records a detector_capped
 * marker and every further row for that detector is suppressed for the day.
 */
async function recordFinding(
  tx: DbTx,
  orgId: string,
  caps: Map<string, number>,
  capReached: Set<string>,
  input: { detector: string; severity: string; subjectKey: string; evidence: Record<string, unknown>; finding: FindingInput },
): Promise<RecordOutcome> {
  const { detector } = input;
  if (capReached.has(detector)) return 'capped';
  let count = caps.get(detector);
  if (count === undefined) {
    count = await detectorCountToday(tx, orgId, detector);
    caps.set(detector, count);
  }
  if (count >= DEFAULT_DETECTOR_DAILY_CAP) {
    capReached.add(detector);
    await recordDetectorCapped(tx, orgId, detector, DEFAULT_DETECTOR_DAILY_CAP);
    return 'capped';
  }
  const dedup = mismatchDedupKey(detector, input.subjectKey);
  const finding: FindingInput = { ...input.finding, dedup_key: dedup, evidence_hash: evidenceHash(input.evidence) };
  const res = await upsertFinding(tx, orgId, finding);
  if (res.was_insert) {
    caps.set(detector, count + 1);
    // Refs + scalars only (spec 16.1), best-effort. A newly opened finding fans out drift.detected
    // and mismatch.opened; detector_capped/currency_mismatch markers do not (not user findings).
    if (detector !== 'detector_capped' && detector !== 'currency_mismatch') {
      void publishBoltEvent(
        'drift.detected',
        'bursar',
        { 'mismatch.id': res.id, detector, severity: input.severity, 'vendor.id': finding.vendor_id ?? null, 'org.id': orgId },
        orgId,
      ).catch(() => {});
      void publishBoltEvent(
        'mismatch.opened',
        'bursar',
        { 'mismatch.id': res.id, detector, severity: input.severity, 'org.id': orgId },
        orgId,
      ).catch(() => {});
    }
    return 'insert';
  }
  return 'update';
}
