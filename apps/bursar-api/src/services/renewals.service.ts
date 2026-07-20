import { sql } from 'drizzle-orm';
import type { BursarRenewalDecide } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { NotFoundError } from '../lib/errors.js';
import type { Viewer } from './types.js';

// Renewal radar read + decide (spec 8 detector 4, 11, M8). The radar rows are maintained by the
// bursar-renewal-radar engine; this surface lists them and records a human decision.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function listRenewals(viewer: Viewer, status?: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const conds = [sql`r.organization_id = ${viewer.org_id}`];
    if (status) conds.push(sql`r.status = ${status}`);
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT r.id, r.award_id, r.chain_root_id, r.vendor_id, v.display_name AS vendor_name,
               r.term_end, r.notice_deadline, r.auto_renew, r.timezone, r.current_band, r.alerted_bands,
               r.status, r.decision, r.decided_at, r.created_at, r.updated_at
          FROM bursar_renewals r
          LEFT JOIN bursar_vendors v ON v.id = r.vendor_id AND v.organization_id = r.organization_id
         WHERE ${sql.join(conds, sql` AND `)}
         ORDER BY r.notice_deadline ASC NULLS LAST, r.created_at DESC
         LIMIT 500
      `),
    );
    return { data: rows };
  });
}

export async function decideRenewal(viewer: Viewer, id: string, body: BursarRenewalDecide) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    // A 'defer' snoozes (status stays pending, decision recorded); renew/let_lapse close the radar.
    const newStatus = body.decision === 'defer' ? 'pending' : 'decided';
    const row = pgRows<{ id: string }>(
      await tx.execute(sql`
        UPDATE bursar_renewals
           SET decision = ${body.decision}, decided_by = ${viewer.id}, decided_at = now(),
               status = ${newStatus}, updated_at = now()
         WHERE organization_id = ${viewer.org_id} AND id = ${id}
        RETURNING id
      `),
    )[0];
    if (!row) throw new NotFoundError('Renewal not found');
    // Resolve any open renewal_cliff finding for this award when the human has decided.
    if (newStatus === 'decided') {
      await tx.execute(sql`
        UPDATE bursar_mismatches SET status = 'resolved', resolved_by = ${viewer.id}, resolved_at = now(), updated_at = now()
         WHERE organization_id = ${viewer.org_id} AND detector = 'renewal_cliff' AND status = 'open'
           AND award_id = (SELECT award_id FROM bursar_renewals WHERE id = ${id} AND organization_id = ${viewer.org_id})
      `);
    }
    return { data: { id, decision: body.decision, status: newStatus } };
  });
}
