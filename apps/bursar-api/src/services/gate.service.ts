import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import type { BursarScopeGap } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { Viewer } from './types.js';

// The ADVISORY scope-gap gate (spec 9, M8). Returns pass|advisory plus cited REASON CODES (never
// cited spans, baseline quotes, or prices), records a bursar_gate_checks row, and publishes
// gate.advisory. There is NO enforcement, NO bill-api preHandler, NO blocking verdict. The internal
// caller shape is specified so v1.1 does not improvise, but nothing composes with Burn's precheck.

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export interface GateResult {
  check_id: string;
  verdict: 'pass' | 'advisory';
  reasons: string[];
}

/**
 * Evaluate the advisory gate. `actingUser` narrows visibility for an internal (agent) caller; the
 * reasons are codes only. source is 'api' for a human/UI call, 'internal' for the service route.
 */
export async function evaluateScopeGap(
  viewer: Viewer,
  body: BursarScopeGap,
  source: 'api' | 'internal',
  actingUserId: string | null,
): Promise<GateResult> {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const reasons: string[] = [];

    // A vendor with no active award: money-out is against an unbaselined vendor.
    if (body.vendor_id) {
      const hasAward = pgRows<{ n: number }>(
        await tx.execute(sql`
          SELECT count(*)::int AS n FROM bursar_awards
           WHERE organization_id = ${viewer.org_id} AND vendor_id = ${body.vendor_id} AND status = 'active'
        `),
      )[0]?.n ?? 0;
      if (hasAward === 0) reasons.push('no_active_award');

      // Open detector findings for this vendor (reason codes only, no figures).
      const openByDetector = pgRows<{ detector: string }>(
        await tx.execute(sql`
          SELECT DISTINCT detector FROM bursar_mismatches
           WHERE organization_id = ${viewer.org_id} AND vendor_id = ${body.vendor_id} AND status = 'open'
        `),
      );
      for (const d of openByDetector) {
        if (d.detector === 'scope_divergence') reasons.push('open_scope_divergence');
        else if (d.detector === 'price_drift') reasons.push('open_price_drift');
        else if (d.detector === 'unbaselined_vendor') reasons.push('unbaselined_vendor');
        else if (d.detector === 'renewal_cliff') reasons.push('renewal_cliff');
      }
    }

    const verdict: 'pass' | 'advisory' = reasons.length > 0 ? 'advisory' : 'pass';
    const inserted = pgRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO bursar_gate_checks (organization_id, check_kind, verdict, request_id, vendor_id,
               subject_ref, reasons, acting_user_id, source)
        VALUES (${viewer.org_id}, 'scope_gap', ${verdict}, ${body.request_id ?? null}, ${body.vendor_id ?? null},
               ${body.subject_ref ?? null}, ${JSON.stringify([...new Set(reasons)])}::jsonb, ${actingUserId}, ${source})
        RETURNING id
      `),
    )[0];

    void publishBoltEvent(
      'gate.advisory',
      'bursar',
      { 'check.id': inserted!.id, verdict, 'request.id': body.request_id ?? null, 'org.id': viewer.org_id },
      viewer.org_id,
    ).catch(() => {});

    return { check_id: inserted!.id, verdict, reasons: [...new Set(reasons)] };
  });
}

export async function listGateChecks(viewer: Viewer, limit = 100) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = pgRows<Record<string, unknown>>(
      await tx.execute(sql`
        SELECT id, check_kind, verdict, request_id, vendor_id, subject_ref, reasons, source, created_at
          FROM bursar_gate_checks
         WHERE organization_id = ${viewer.org_id}
         ORDER BY created_at DESC
         LIMIT ${limit}
      `),
    );
    return { data: rows };
  });
}
