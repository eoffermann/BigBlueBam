// The four numbers (spec 2.3), computed from effectiveStatus over active controls with at least
// one applicable requirement link. Pure core plus one loader; readiness.weekly uses it at M4 and
// the Readiness page, GET /coverage and GET /summary reuse it at M5.

import type { Tx } from './context.js';
import { type AssertionLatest, type CitedRef, effectiveStatus, type ExceptionRow } from './status.js';

export interface ControlForNumbers {
  control_id: string;
  last_evaluated_at: Date | null;
  assertions: Array<AssertionLatest & { kind: 'probe' | 'manual' | 'feed' }>;
  /** Confirmed assertions that have no snapshot yet (they count as set up, not evaluated). */
  confirmed_count: number;
}

export interface ReadinessNumbers {
  proven_by_suite: number;
  proven_by_evidence: number;
  not_met: number;
  risk_accepted: number;
  cant_prove: number;
  not_set_up: number;
  checked: number;
  total: number;
}

export function computeNumbers(controls: ControlForNumbers[], exceptions: ExceptionRow[], staleAfterHours: number, now: Date): ReadinessNumbers {
  const n: ReadinessNumbers = { proven_by_suite: 0, proven_by_evidence: 0, not_met: 0, risk_accepted: 0, cant_prove: 0, not_set_up: 0, checked: 0, total: controls.length };
  for (const c of controls) {
    if (c.confirmed_count === 0) {
      n.not_set_up += 1;
      continue;
    }
    n.checked += 1;
    // A confirmed assertion with no snapshot yet cannot vouch for anything.
    const pending: AssertionLatest[] =
      c.assertions.length < c.confirmed_count
        ? [{ assertion_id: 'not-yet-evaluated', outcome: 'unprovable', unprovable_reason: 'evaluation_stale', cited_refs: [] }]
        : [];
    const eff = effectiveStatus(
      {
        last_evaluated_at: c.last_evaluated_at,
        stale_after_hours: staleAfterHours,
        assertions: [...c.assertions, ...pending],
        exceptions: exceptions.filter((e) => e.control_id === undefined || e.control_id === c.control_id),
      },
      now,
    );
    if (eff.state === 'pass') {
      const anyManual = c.assertions.some((a) => a.kind === 'manual' && a.outcome === 'pass');
      if (anyManual) n.proven_by_evidence += 1;
      else n.proven_by_suite += 1;
    } else if (eff.state === 'fail') n.not_met += 1;
    else if (eff.state === 'pass_with_exception') {
      n.not_met += 1;
      n.risk_accepted += 1;
    } else n.cant_prove += 1;
  }
  return n;
}

export async function loadReadinessNumbers(tx: Tx, orgId: string, now: Date, frameworkId?: string): Promise<ReadinessNumbers> {
  const settings = (await tx`SELECT stale_after_hours FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  const stale = Number(settings?.stale_after_hours ?? 36);
  const controls = await tx`
    SELECT c.id, c.last_evaluated_at
      FROM bastion_controls c
     WHERE c.organization_id = ${orgId} AND c.lifecycle = 'active'
       AND EXISTS (SELECT 1 FROM bastion_control_requirements r
                     JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                    WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                      AND r.applicability = 'applicable' AND f.status <> 'archived'
                      ${frameworkId ? tx`AND f.id = ${frameworkId}` : tx``})`;
  const latest = await tx`
    SELECT a.id AS assertion_id, a.control_id, a.kind, s.outcome, s.unprovable_reason, s.cited_refs
      FROM bastion_assertions a
      LEFT JOIN LATERAL (
        SELECT outcome, unprovable_reason, cited_refs FROM bastion_evidence_snapshots s
         WHERE s.organization_id = a.organization_id AND s.assertion_id = a.id
         ORDER BY s.created_at DESC LIMIT 1) s ON true
     WHERE a.organization_id = ${orgId} AND a.review_status = 'confirmed'`;
  const exceptions = await tx`
    SELECT id, control_id, scope, assertion_id, cited_entity_type, cited_entity_id, frozen_refs, status, expires_at
      FROM bastion_exceptions WHERE organization_id = ${orgId} AND status = 'active'`;
  const byControl = new Map<string, ControlForNumbers>();
  for (const c of controls) {
    byControl.set(c.id as string, {
      control_id: c.id as string,
      last_evaluated_at: c.last_evaluated_at ? new Date(c.last_evaluated_at as string) : null,
      assertions: [],
      confirmed_count: 0,
    });
  }
  for (const a of latest) {
    const c = byControl.get(a.control_id as string);
    if (!c) continue;
    c.confirmed_count += 1;
    if (a.outcome) {
      c.assertions.push({
        assertion_id: a.assertion_id as string,
        kind: a.kind as 'probe' | 'manual' | 'feed',
        outcome: a.outcome as 'pass' | 'fail' | 'unprovable',
        unprovable_reason: (a.unprovable_reason as string | null) ?? null,
        cited_refs: (a.cited_refs as CitedRef[]) ?? [],
      });
    }
  }
  const exRows = exceptions.map((e) => ({
    id: e.id as string,
    control_id: e.control_id as string,
    scope: e.scope as 'entity' | 'assertion',
    assertion_id: (e.assertion_id as string | null) ?? null,
    cited_entity_type: (e.cited_entity_type as string | null) ?? null,
    cited_entity_id: (e.cited_entity_id as string | null) ?? null,
    frozen_refs: (e.frozen_refs as CitedRef[] | null) ?? null,
    status: e.status as string,
    expires_at: new Date(e.expires_at as string),
  }));
  return computeNumbers([...byControl.values()], exRows, stale, now);
}
