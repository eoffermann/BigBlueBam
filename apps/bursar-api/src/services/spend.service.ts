import { sql } from 'drizzle-orm';
import { toCsv } from '@bigbluebam/shared';
import type { BursarSpendImport } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { normalizePayee, type VendorCandidate, type PayeeMatchThresholds } from '../lib/payee-normalize.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import {
  prepareSpendEvents,
  runSpendImport,
  type SpendImportStore,
  type PreparedSpendEvent,
  type SpendImportResult,
} from './engines/spend-import.js';
import type { Viewer } from './types.js';

// Spend surface (spec 6.1, 11, M8). Observed statement stream: import (resumable, deduped), list,
// per-vendor rollup, and CSV export (formula-neutralized). Every query carries an explicit
// organization_id predicate. The financial floor (bursar.spend.read_all) is applied at the route
// serializer via redactFinancialFields; the CSV export is gated by the route's read_all metadata.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** The DB-backed SpendImportStore (the resume + "0 new" contract lives in the pure engine). */
function makeDbSpendImportStore(tx: import('../db/index.js').DbTx, orgId: string, importedBy: string | null): SpendImportStore {
  return {
    async upsertBatch(fileSha256, filename) {
      // Read the prior status (null if new) BEFORE the upsert so `resumed` is accurate, then
      // upsert to status='running'. ON CONFLICT DO UPDATE re-opens a crashed/partial batch.
      const prior = pgRows<{ status: string }>(
        await tx.execute(sql`
          SELECT status FROM bursar_spend_imports
           WHERE organization_id = ${orgId} AND file_sha256 = ${fileSha256} LIMIT 1
        `),
      )[0];
      const inserted = pgRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO bursar_spend_imports (organization_id, file_sha256, filename, imported_by, status)
          VALUES (${orgId}, ${fileSha256}, ${filename}, ${importedBy}, 'running')
          ON CONFLICT (organization_id, file_sha256)
          DO UPDATE SET status = 'running', updated_at = now()
          RETURNING id
        `),
      )[0];
      return { importId: inserted!.id, priorStatus: prior?.status ?? null };
    },

    async insertEvents(importId, events) {
      if (events.length === 0) return 0;
      // Build a multi-row INSERT ... ON CONFLICT (organization_id, dedup_key) DO NOTHING RETURNING id.
      const values = events.map(
        (e) => sql`(
          ${orgId}, 'import.csv', ${importId}, ${e.vendor_id}, ${e.occurred_on}, ${e.amount_minor},
          ${e.currency}, ${e.payee_raw}, ${e.normalized_payee}, ${e.funding_source}, ${e.external_ref},
          ${e.match_method}, ${e.match_confidence}, ${e.dedup_key}, ${e.occurrence_ordinal}
        )`,
      );
      const inserted = pgRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO bursar_spend_events (
            organization_id, source_type, spend_import_id, vendor_id, occurred_on, amount_minor,
            currency, payee_raw, normalized_payee, funding_source, external_ref,
            match_method, match_confidence, dedup_key, occurrence_ordinal
          )
          VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT (organization_id, dedup_key) DO NOTHING
          RETURNING id
        `),
      );
      return inserted.length;
    },

    async finalizeBatch(importId, counts) {
      await tx.execute(sql`
        UPDATE bursar_spend_imports
           SET row_count = ${counts.row_count}, rows_inserted = ${counts.rows_inserted},
               rows_deduped = ${counts.rows_deduped}, status = 'succeeded', updated_at = now()
         WHERE organization_id = ${orgId} AND id = ${importId}
      `);
    },
  };
}

async function loadVendorCandidates(tx: import('../db/index.js').DbTx, orgId: string): Promise<VendorCandidate[]> {
  const rows = pgRows<{ id: string; display_name: string }>(
    await tx.execute(sql`
      SELECT id, display_name FROM bursar_vendors
       WHERE organization_id = ${orgId} AND status = 'active'
    `),
  );
  return rows.map((r) => ({ vendor_id: r.id, normalized_name: normalizePayee(r.display_name) }));
}

export async function importSpend(
  viewer: Viewer,
  input: BursarSpendImport,
  thresholds?: PayeeMatchThresholds,
): Promise<SpendImportResult & { normalized_new: number }> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const candidates = await loadVendorCandidates(tx, viewer.org_id);
    const events: PreparedSpendEvent[] = prepareSpendEvents(input.rows, candidates, thresholds);
    const store = makeDbSpendImportStore(tx, viewer.org_id, viewer.id);
    const result = await runSpendImport(store, {
      file_sha256: input.file_sha256,
      filename: input.filename ?? null,
      events,
    });
    // "0 new" is derived from rows_deduped: new events are those that actually inserted this run.
    return { ...result, normalized_new: result.rows_inserted };
  });
}

export interface SpendListParams {
  cursor?: string;
  limit: number;
  vendorId?: string;
  normalizedPayee?: string;
}

export async function listSpend(viewer: Viewer, params: SpendListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cur = decodeCursor(params.cursor);
    const conds = [sql`organization_id = ${viewer.org_id}`];
    if (params.vendorId) conds.push(sql`vendor_id = ${params.vendorId}`);
    if (params.normalizedPayee) conds.push(sql`normalized_payee = ${params.normalizedPayee}`);
    if (cur) {
      conds.push(sql`(created_at, id) < (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`);
    }
    const rows = pgRows<{ id: string; created_at: string }>(
      await tx.execute(sql`
        SELECT id, source_type, vendor_id, occurred_on, amount_minor, currency, payee_raw,
               normalized_payee, funding_source, external_ref, matched_baseline_item_id,
               match_method, match_confidence, occurrence_ordinal, created_at
          FROM bursar_spend_events
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY created_at DESC, id DESC
         LIMIT ${params.limit + 1}
      `),
    );
    const page = rows.length <= params.limit ? { items: rows, next: null as string | null } : (() => {
      const items = rows.slice(0, params.limit);
      const last = items[items.length - 1]!;
      return { items, next: encodeCursor({ createdAt: String(last.created_at), id: last.id }) };
    })();
    return { data: page.items, next_cursor: page.next };
  });
}

/**
 * Per-vendor (and per-shadow-payee) spend rollup. Rows with a resolved vendor group by vendor;
 * unresolved spend (vendor_id NULL) groups by normalized_payee - the shadow-IT bucket the
 * unbaselined_vendor detector mines.
 */
export async function listSpendByVendor(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = pgRows<{
      vendor_id: string | null;
      display_name: string | null;
      normalized_payee: string | null;
      event_count: number;
      spend_minor: number;
      currency: string;
      first_occurred_on: string;
      last_occurred_on: string;
    }>(
      await tx.execute(sql`
        SELECT se.vendor_id,
               v.display_name,
               CASE WHEN se.vendor_id IS NULL THEN se.normalized_payee ELSE NULL END AS normalized_payee,
               count(*)::int AS event_count,
               sum(se.amount_minor)::bigint AS spend_minor,
               max(se.currency) AS currency,
               min(se.occurred_on) AS first_occurred_on,
               max(se.occurred_on) AS last_occurred_on
          FROM bursar_spend_events se
          LEFT JOIN bursar_vendors v ON v.id = se.vendor_id AND v.organization_id = se.organization_id
         WHERE se.organization_id = ${viewer.org_id}
         GROUP BY se.vendor_id, v.display_name,
                  CASE WHEN se.vendor_id IS NULL THEN se.normalized_payee ELSE NULL END
         ORDER BY spend_minor DESC
         LIMIT 500
      `),
    );
    return {
      data: rows.map((r) => ({
        vendor_id: r.vendor_id,
        display_name: r.display_name ?? r.normalized_payee ?? '(unresolved)',
        is_unbaselined: r.vendor_id === null,
        event_count: r.event_count,
        spend_minor: r.spend_minor,
        currency: r.currency,
        first_occurred_on: r.first_occurred_on,
        last_occurred_on: r.last_occurred_on,
      })),
    };
  });
}

export async function listSpendImports(viewer: Viewer, limit = 50) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT id, file_sha256, filename, row_count, rows_inserted, rows_deduped, status,
               imported_by, created_at, updated_at
          FROM bursar_spend_imports
         WHERE organization_id = ${viewer.org_id}
         ORDER BY created_at DESC
         LIMIT ${limit}
      `),
    );
    return { data: rows };
  });
}

/**
 * CSV export of the spend stream, FORMULA-NEUTRALIZED via the shared @bigbluebam/shared toCsv
 * helper so a crafted payee cannot execute on open. Gated by the route's bursar.spend.read_all
 * permission metadata; money columns are present because a read_all caller reached this route.
 */
export async function exportSpendCsv(viewer: Viewer): Promise<string> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = pgRows<{
      occurred_on: string;
      payee_raw: string | null;
      normalized_payee: string | null;
      amount_minor: number;
      currency: string;
      external_ref: string | null;
      funding_source: string | null;
      vendor_name: string | null;
      source_type: string;
    }>(
      await tx.execute(sql`
        SELECT se.occurred_on, se.payee_raw, se.normalized_payee, se.amount_minor, se.currency,
               se.external_ref, se.funding_source, v.display_name AS vendor_name, se.source_type
          FROM bursar_spend_events se
          LEFT JOIN bursar_vendors v ON v.id = se.vendor_id AND v.organization_id = se.organization_id
         WHERE se.organization_id = ${viewer.org_id}
         ORDER BY se.occurred_on DESC, se.id DESC
         LIMIT 100000
      `),
    );
    const header = [
      'occurred_on', 'payee_raw', 'normalized_payee', 'vendor', 'amount_minor', 'currency',
      'external_ref', 'funding_source', 'source',
    ];
    const body = rows.map((r) => [
      r.occurred_on, r.payee_raw, r.normalized_payee, r.vendor_name, r.amount_minor, r.currency,
      r.external_ref, r.funding_source, r.source_type,
    ]);
    return toCsv(header, body);
  });
}
