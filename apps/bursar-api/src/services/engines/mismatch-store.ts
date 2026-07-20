import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbTx } from '../../db/index.js';

// Shared mismatch (finding) upsert (spec 8, M8). Every detector routes its findings through here so
// the noise-control invariants live in ONE place:
//   - dedup_key upsert bumps last_seen_at (a recurring finding is one row, not N);
//   - dismissed is STICKY by dedup_key unless the evidence_hash changes (a human dismissal is not
//     re-opened by the next identical sweep, but a materially changed finding re-opens);
//   - a per-org per-detector DAILY CAP (default 200) records a single detector_capped marker and
//     stops creating that detector's findings for the day.

export const DEFAULT_DETECTOR_DAILY_CAP = 200;

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Stable dedup key for a finding: hash(detector + a subject key). Re-runs update, never duplicate. */
export function mismatchDedupKey(detector: string, subjectKey: string): string {
  return createHash('sha256').update(`${detector}${subjectKey}`, 'utf8').digest('hex');
}

/** Evidence hash over the material figures so a dismissal is sticky until the evidence changes. */
export function evidenceHash(evidence: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

export interface FindingInput {
  detector: string;
  severity: string;
  dedup_key: string;
  evidence_hash: string;
  vendor_id?: string | null;
  award_id?: string | null;
  chain_root_id?: string | null;
  request_id?: string | null;
  offer_id?: string | null;
  scope_node_id?: string | null;
  baseline_item_id?: string | null;
  spend_event_id?: string | null;
  normalized_payee?: string | null;
  dollars_at_stake_minor?: number | null;
  currency?: string | null;
  basis?: string | null;
  cited_span?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

export interface UpsertResult {
  id: string;
  was_insert: boolean;
}

/**
 * Upsert a finding. dedup_key is unique per (organization_id, dedup_key). On conflict: bump
 * last_seen_at and refresh the evidence; if the existing row is dismissed and the evidence hash is
 * unchanged it STAYS dismissed, but a changed evidence hash re-opens it. was_insert distinguishes a
 * brand-new finding (fire mismatch.opened) from a recurrence.
 */
export async function upsertFinding(tx: DbTx, orgId: string, f: FindingInput): Promise<UpsertResult> {
  const rows = pgRows<{ id: string; was_insert: boolean }>(
    await tx.execute(sql`
      INSERT INTO bursar_mismatches (
        organization_id, detector, severity, status, dedup_key, evidence_hash,
        vendor_id, award_id, chain_root_id, request_id, offer_id, scope_node_id,
        baseline_item_id, spend_event_id, normalized_payee, dollars_at_stake_minor, currency,
        basis, cited_span, details, first_seen_at, last_seen_at
      ) VALUES (
        ${orgId}, ${f.detector}, ${f.severity}, 'open', ${f.dedup_key}, ${f.evidence_hash},
        ${f.vendor_id ?? null}, ${f.award_id ?? null}, ${f.chain_root_id ?? null}, ${f.request_id ?? null},
        ${f.offer_id ?? null}, ${f.scope_node_id ?? null}, ${f.baseline_item_id ?? null},
        ${f.spend_event_id ?? null}, ${f.normalized_payee ?? null}, ${f.dollars_at_stake_minor ?? null},
        ${f.currency ?? null}, ${f.basis ?? null}, ${JSON.stringify(f.cited_span ?? {})}::jsonb,
        ${JSON.stringify(f.details ?? {})}::jsonb, now(), now()
      )
      ON CONFLICT (organization_id, dedup_key) DO UPDATE SET
        last_seen_at = now(),
        severity = EXCLUDED.severity,
        dollars_at_stake_minor = EXCLUDED.dollars_at_stake_minor,
        currency = EXCLUDED.currency,
        basis = EXCLUDED.basis,
        details = EXCLUDED.details,
        cited_span = EXCLUDED.cited_span,
        evidence_hash = EXCLUDED.evidence_hash,
        status = CASE
          WHEN bursar_mismatches.status = 'dismissed' AND bursar_mismatches.evidence_hash IS DISTINCT FROM EXCLUDED.evidence_hash THEN 'open'
          ELSE bursar_mismatches.status
        END,
        updated_at = now()
      RETURNING id, (xmax = 0) AS was_insert
    `),
  );
  return { id: rows[0]!.id, was_insert: rows[0]!.was_insert };
}

/** Count findings already created today for (org, detector), to enforce the daily cap. */
export async function detectorCountToday(tx: DbTx, orgId: string, detector: string): Promise<number> {
  const rows = pgRows<{ n: number }>(
    await tx.execute(sql`
      SELECT count(*)::int AS n FROM bursar_mismatches
       WHERE organization_id = ${orgId} AND detector = ${detector}
         AND created_at::date = now()::date
    `),
  );
  return rows[0]?.n ?? 0;
}

/** Record a single detector_capped marker for (org, detector) so the cap is visible, idempotent per day. */
export async function recordDetectorCapped(tx: DbTx, orgId: string, detector: string, cap: number): Promise<void> {
  const key = mismatchDedupKey('detector_capped', `${detector}${new Date().toISOString().slice(0, 10)}`);
  await upsertFinding(tx, orgId, {
    detector: 'detector_capped',
    severity: 'low',
    dedup_key: key,
    evidence_hash: evidenceHash({ detector, cap }),
    details: { capped_detector: detector, cap, note: 'daily finding cap reached; further findings suppressed today' },
  });
}
