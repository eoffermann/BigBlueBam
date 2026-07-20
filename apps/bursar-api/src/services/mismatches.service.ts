import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarMismatchDecision, BursarMarkWrong } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { NotFoundError } from '../lib/errors.js';
import type { Viewer } from './types.js';

// Mismatch inbox (spec 8, 11, M8): list / detail / resolve / dismiss / mark-wrong. Every query
// carries an explicit organization_id predicate. Money projection is floored at the route.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface MismatchListParams {
  cursor?: string;
  limit: number;
  status?: string;
  detector?: string;
  vendorId?: string;
}

export async function listMismatches(viewer: Viewer, params: MismatchListParams) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const cur = decodeCursor(params.cursor);
    const conds = [sql`organization_id = ${viewer.org_id}`];
    if (params.status) conds.push(sql`status = ${params.status}`);
    if (params.detector) conds.push(sql`detector = ${params.detector}`);
    if (params.vendorId) conds.push(sql`vendor_id = ${params.vendorId}`);
    if (cur) conds.push(sql`(created_at, id) < (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`);
    const rows = pgRows<{ id: string; created_at: string }>(
      await tx.execute(sql`
        SELECT id, detector, severity, status, vendor_id, award_id, chain_root_id, request_id, offer_id,
               scope_node_id, baseline_item_id, spend_event_id, normalized_payee, dollars_at_stake_minor,
               currency, basis, cited_span, details, first_seen_at, last_seen_at, created_at, updated_at
          FROM bursar_mismatches
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY created_at DESC, id DESC
         LIMIT ${params.limit + 1}
      `),
    );
    if (rows.length <= params.limit) return { data: rows, next_cursor: null as string | null };
    const items = rows.slice(0, params.limit);
    const last = items[items.length - 1]!;
    return { data: items, next_cursor: encodeCursor({ createdAt: String(last.created_at), id: last.id }) };
  });
}

export async function getMismatch(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const row = pgRows<Record<string, unknown>>(
      await tx.execute(sql`SELECT * FROM bursar_mismatches WHERE organization_id = ${viewer.org_id} AND id = ${id} LIMIT 1`),
    )[0];
    if (!row) throw new NotFoundError('Mismatch not found');
    return { data: row };
  });
}

async function decide(viewer: Viewer, id: string, status: 'resolved' | 'dismissed', note: string | undefined) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const col = status === 'resolved' ? sql`resolved_by = ${viewer.id}, resolved_at = now()` : sql`dismissed_by = ${viewer.id}, dismissed_at = now()`;
    const row = pgRows<{ id: string; detector: string }>(
      await tx.execute(sql`
        UPDATE bursar_mismatches
           SET status = ${status}, ${col},
               details = jsonb_set(COALESCE(details, '{}'::jsonb), '{decision_note}', ${JSON.stringify(note ?? null)}::jsonb),
               updated_at = now()
         WHERE organization_id = ${viewer.org_id} AND id = ${id}
        RETURNING id, detector
      `),
    )[0];
    if (!row) throw new NotFoundError('Mismatch not found');
    void publishBoltEvent('mismatch.resolved', 'bursar', { 'mismatch.id': row.id, detector: row.detector, status, 'org.id': viewer.org_id }, viewer.org_id).catch(() => {});
    return { data: { id: row.id, status } };
  });
}

export function resolveMismatch(viewer: Viewer, id: string, body: BursarMismatchDecision) {
  return decide(viewer, id, 'resolved', body.note);
}
export function dismissMismatch(viewer: Viewer, id: string, body: BursarMismatchDecision) {
  return decide(viewer, id, 'dismissed', body.note);
}

/**
 * Record a "the detector fired wrong" human verdict into bursar_detector_feedback (threshold
 * calibration) and dismiss the finding. A wrong verdict is sticky: the dismiss is by dedup_key
 * (spec 8), so the next identical sweep does not re-open it unless the evidence changes.
 */
export async function markWrong(viewer: Viewer, id: string, body: BursarMarkWrong) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const m = pgRows<{ id: string; detector: string }>(
      await tx.execute(sql`SELECT id, detector FROM bursar_mismatches WHERE organization_id = ${viewer.org_id} AND id = ${id} LIMIT 1`),
    )[0];
    if (!m) throw new NotFoundError('Mismatch not found');
    await tx.execute(sql`
      INSERT INTO bursar_detector_feedback (organization_id, mismatch_id, detector, verdict, reason, created_by)
      VALUES (${viewer.org_id}, ${id}, ${m.detector}, 'wrong', ${body.reason}, ${viewer.id})
    `);
    await tx.execute(sql`
      UPDATE bursar_mismatches SET status = 'dismissed', dismissed_by = ${viewer.id}, dismissed_at = now(), updated_at = now()
       WHERE organization_id = ${viewer.org_id} AND id = ${id}
    `);
    void publishBoltEvent('mismatch.resolved', 'bursar', { 'mismatch.id': id, detector: m.detector, status: 'dismissed', 'org.id': viewer.org_id }, viewer.org_id).catch(() => {});
    return { data: { id, status: 'dismissed', feedback: 'wrong' } };
  });
}
