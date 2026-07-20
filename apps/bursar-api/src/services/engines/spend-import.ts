/**
 * Resumable spend-import core (spec 6.1, M8). No db/env import so the M8 unit suite proves the
 * resume + "0 new" contract against an in-memory store. The DB store and the list/by-vendor/export
 * reads live in spend.service.ts.
 *
 * THE TWO CONTRACTS THIS ENFORCES:
 *
 *  1. RESUMABILITY. bursar_spend_imports is UNIQUE (organization_id, file_sha256) with an
 *     upsert-and-resume: re-uploading the same file re-opens the batch at status='running' and
 *     re-runs the upsert loop. Events insert ON CONFLICT (organization_id, dedup_key) DO NOTHING,
 *     so a crash at row 200 of 412 is retried by re-uploading; the 200 already-inserted rows dedup
 *     and the remaining 212 land. A bare unique constraint (no resume) would lose the 212 forever.
 *
 *  2. "0 NEW" IS DERIVED FROM rows_deduped, NEVER FROM THE BATCH ROW'S EXISTENCE. A fully
 *     re-imported file reports rows_inserted=0 because every row deduped, not because "the batch
 *     already exists". The two are different: the second is true after the FIRST partial run too,
 *     and reading it as "done" is exactly the silent-under-report bug occurrence_ordinal guards.
 */

import { resolvePayee, type VendorCandidate, type PayeeMatchThresholds } from '../../lib/payee-normalize.js';
import { assignOccurrenceOrdinals } from '../../lib/spend-dedup-key.js';

export interface SpendImportRow {
  payee_raw: string;
  occurred_on: string; // YYYY-MM-DD
  amount_minor: number;
  currency: string;
  external_ref?: string | null;
  funding_source?: string | null;
}

export interface PreparedSpendEvent {
  payee_raw: string;
  normalized_payee: string;
  vendor_id: string | null;
  match_method: string | null;
  match_confidence: number | null;
  occurred_on: string;
  amount_minor: number;
  currency: string;
  external_ref: string | null;
  funding_source: string | null;
  occurrence_ordinal: number;
  dedup_key: string;
}

/**
 * Normalize payees, resolve each to a vendor via trigram (auto-accept only; a needs_review or
 * no_match leaves vendor_id NULL - the shadow-IT bucket that unbaselined_vendor mines), then assign
 * per-file occurrence ordinals + dedup keys. Pure and order-preserving.
 */
export function prepareSpendEvents(
  rows: readonly SpendImportRow[],
  vendorCandidates: readonly VendorCandidate[],
  thresholds?: PayeeMatchThresholds,
): PreparedSpendEvent[] {
  const resolved = rows.map((r) => {
    const res = resolvePayee(r.payee_raw, [...vendorCandidates], thresholds);
    return {
      payee_raw: r.payee_raw,
      normalized_payee: res.normalized_payee,
      // Only an auto_accept link writes a vendor_id at import time; anything softer stays NULL.
      vendor_id: res.disposition === 'auto_accept' ? res.vendor_id : null,
      match_method: res.disposition === 'auto_accept' ? 'auto' : null,
      match_confidence: res.disposition === 'auto_accept' ? res.score : null,
      occurred_on: r.occurred_on,
      amount_minor: r.amount_minor,
      currency: (r.currency ?? 'USD').toUpperCase(),
      external_ref: r.external_ref ?? null,
      funding_source: r.funding_source ?? null,
    };
  });
  // Ordinals + dedup keys over the canonical tuple (uses normalized_payee, occurred_on,
  // amount_minor, currency, external_ref, occurrence_ordinal).
  const withKeys = assignOccurrenceOrdinals(
    resolved.map((r) => ({
      normalized_payee: r.normalized_payee,
      occurred_on: r.occurred_on,
      amount_minor: r.amount_minor,
      currency: r.currency,
      external_ref: r.external_ref,
    })),
  );
  return resolved.map((r, i) => ({
    ...r,
    occurrence_ordinal: withKeys[i]!.occurrence_ordinal,
    dedup_key: withKeys[i]!.dedup_key,
  }));
}

export interface SpendImportResult {
  import_id: string;
  row_count: number;
  rows_inserted: number;
  rows_deduped: number;
  status: 'succeeded';
  resumed: boolean;
}

/**
 * The batch header + event-insert persistence surface, injected so the resume + "0 new" contract
 * is proven against an in-memory store without a DB.
 */
export interface SpendImportStore {
  /**
   * Upsert the batch header ON CONFLICT (organization_id, file_sha256) DO UPDATE SET
   * status='running'. Returns the import id and the status the row had BEFORE this upsert (null if
   * the row is brand new) so the caller can report `resumed`.
   */
  upsertBatch(fileSha256: string, filename: string | null): Promise<{ importId: string; priorStatus: string | null }>;
  /**
   * Insert events ON CONFLICT (organization_id, dedup_key) DO NOTHING. Returns the count actually
   * INSERTED (RETURNING count); the rest deduped.
   */
  insertEvents(importId: string, events: readonly PreparedSpendEvent[]): Promise<number>;
  /** Finalize the batch header with the derived counts and status='succeeded'. */
  finalizeBatch(importId: string, counts: { row_count: number; rows_inserted: number; rows_deduped: number }): Promise<void>;
}

/**
 * Run (or resume) a spend import. rows_inserted is the count newly inserted THIS invocation;
 * rows_deduped = row_count - rows_inserted. On a full re-import every row deduped, so
 * rows_inserted=0 - the "0 new" signal, derived from the counts and never from the batch row's
 * mere existence.
 */
export async function runSpendImport(
  store: SpendImportStore,
  input: { file_sha256: string; filename: string | null; events: readonly PreparedSpendEvent[] },
): Promise<SpendImportResult> {
  const { importId, priorStatus } = await store.upsertBatch(input.file_sha256, input.filename);
  const rowCount = input.events.length;
  const inserted = await store.insertEvents(importId, input.events);
  const deduped = rowCount - inserted;
  await store.finalizeBatch(importId, { row_count: rowCount, rows_inserted: inserted, rows_deduped: deduped });
  return {
    import_id: importId,
    row_count: rowCount,
    rows_inserted: inserted,
    rows_deduped: deduped,
    status: 'succeeded',
    // Resumed when the batch row already existed and had not succeeded.
    resumed: priorStatus !== null && priorStatus !== 'succeeded',
  };
}
