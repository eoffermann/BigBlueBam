// The four numbers (spec 2.3), computed from effectiveStatus over active controls with at least
// one applicable requirement link. One loader (loadControlStates) feeds every reader:
// readiness.weekly (M4), GET /summary, GET /coverage and the Readiness page (M5), so the numbers,
// the Evidence map and the weekly event can never disagree.

import type { BastionEffectiveState, BastionEvidenceSourceColumn, BastionReadinessNumbersOut, BastionUnprovableReason } from '@bigbluebam/shared';
import type { Tx } from './context.js';
import { type AssertionLatest, type CitedRef, coverageKindOf, effectiveStatus, type ExceptionRow } from './status.js';

export interface ControlForNumbers {
  control_id: string;
  last_evaluated_at: Date | null;
  assertions: Array<AssertionLatest & { kind: 'probe' | 'manual' | 'feed' }>;
  /** Confirmed assertions that have no snapshot yet (they count as set up, not evaluated). */
  confirmed_count: number;
}

/** The shared shape (bastionReadinessNumbersSchema), so the API and the SPA cannot drift (#215). */
export type ReadinessNumbers = BastionReadinessNumbersOut;

export type NumbersBucket = 'proven_by_suite' | 'proven_by_evidence' | 'not_met' | 'cant_prove' | 'not_set_up';

export interface ControlVerdict {
  bucket: NumbersBucket;
  state: BastionEffectiveState | null;
  reason: BastionUnprovableReason | null;
  risk_accepted: boolean;
}

/** Which number one control counts under, and its effective state (null when not set up). */
export function verdictOf(c: ControlForNumbers, exceptions: ExceptionRow[], staleAfterHours: number, now: Date): ControlVerdict {
  if (c.confirmed_count === 0) return { bucket: 'not_set_up', state: null, reason: 'not_yet_confirmed', risk_accepted: false };
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
    return { bucket: anyManual ? 'proven_by_evidence' : 'proven_by_suite', state: 'pass', reason: null, risk_accepted: false };
  }
  if (eff.state === 'fail') return { bucket: 'not_met', state: 'fail', reason: null, risk_accepted: false };
  if (eff.state === 'pass_with_exception') return { bucket: 'not_met', state: 'pass_with_exception', reason: null, risk_accepted: true };
  return { bucket: 'cant_prove', state: 'unprovable', reason: eff.reason, risk_accepted: false };
}

export function computeNumbers(controls: ControlForNumbers[], exceptions: ExceptionRow[], staleAfterHours: number, now: Date): ReadinessNumbers {
  const n: ReadinessNumbers = { proven_by_suite: 0, proven_by_evidence: 0, not_met: 0, risk_accepted: 0, cant_prove: 0, not_set_up: 0, checked: 0, total: controls.length };
  for (const c of controls) {
    const v = verdictOf(c, exceptions, staleAfterHours, now);
    n[v.bucket] += 1;
    if (v.bucket !== 'not_set_up') n.checked += 1;
    if (v.risk_accepted) n.risk_accepted += 1;
  }
  return n;
}

/** Per control: what the Evidence map shows. */
export interface ControlState extends ControlForNumbers {
  control_key: string;
  title: string;
  category: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  /** Confirmed assertions by source column (spec 6.1 Evidence map). */
  columns: Record<Exclude<BastionEvidenceSourceColumn, 'none'>, number>;
  /** Manual-evidence expiry from the latest passing manual snapshot, if any. */
  manual_expires_at: Date | null;
  verdict: ControlVerdict;
}

export interface LoadedStates {
  controls: ControlState[];
  exceptions: ExceptionRow[];
  stale_after_hours: number;
  /** Active controls linked to the view whose every link is not applicable. */
  not_applicable: Array<{ control_id: string; control_key: string; title: string }>;
}

export async function loadControlStates(tx: Tx, orgId: string, now: Date, frameworkId?: string): Promise<LoadedStates> {
  const settings = (await tx`SELECT stale_after_hours FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  const stale = Number(settings?.stale_after_hours ?? 36);
  const fw = () => (frameworkId ? tx`AND f.id = ${frameworkId}` : tx``);
  const controls = await tx`
    SELECT c.id, c.control_key, c.title, c.category, c.owner_user_id, u.display_name AS owner_name, c.last_evaluated_at
      FROM bastion_controls c
      LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE c.organization_id = ${orgId} AND c.lifecycle = 'active'
       AND EXISTS (SELECT 1 FROM bastion_control_requirements r
                     JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                    WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                      AND r.applicability = 'applicable' AND f.status <> 'archived' ${fw()})
     ORDER BY c.control_key`;
  const notApplicable = await tx`
    SELECT c.id, c.control_key, c.title
      FROM bastion_controls c
     WHERE c.organization_id = ${orgId} AND c.lifecycle = 'active'
       AND EXISTS (SELECT 1 FROM bastion_control_requirements r
                     JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                    WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                      AND f.status <> 'archived' ${fw()})
       AND NOT EXISTS (SELECT 1 FROM bastion_control_requirements r
                         JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                        WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                          AND r.applicability = 'applicable' AND f.status <> 'archived' ${fw()})
     ORDER BY c.control_key`;
  const latest = await tx`
    SELECT a.id AS assertion_id, a.control_id, a.kind, a.manual_evidence_spec->>'kind' AS manual_kind,
           s.outcome, s.unprovable_reason, s.cited_refs, s.summary
      FROM bastion_assertions a
      LEFT JOIN LATERAL (
        SELECT outcome, unprovable_reason, cited_refs, summary FROM bastion_evidence_snapshots s
         WHERE s.organization_id = a.organization_id AND s.assertion_id = a.id
         ORDER BY s.created_at DESC LIMIT 1) s ON true
     WHERE a.organization_id = ${orgId} AND a.review_status = 'confirmed'`;
  const exceptions = await tx`
    SELECT id, control_id, scope, assertion_id, cited_entity_type, cited_entity_id, frozen_refs, status, expires_at
      FROM bastion_exceptions WHERE organization_id = ${orgId} AND status = 'active'`;
  const byControl = new Map<string, ControlState>();
  for (const c of controls) {
    byControl.set(c.id as string, {
      control_id: c.id as string,
      control_key: c.control_key as string,
      title: c.title as string,
      category: (c.category as string | null) ?? null,
      owner_user_id: (c.owner_user_id as string | null) ?? null,
      owner_name: (c.owner_name as string | null) ?? null,
      last_evaluated_at: c.last_evaluated_at ? new Date(c.last_evaluated_at as string) : null,
      assertions: [],
      confirmed_count: 0,
      columns: { native: 0, feed: 0, manual_file: 0, self_attested: 0 },
      manual_expires_at: null,
      verdict: { bucket: 'not_set_up', state: null, reason: 'not_yet_confirmed', risk_accepted: false },
    });
  }
  for (const a of latest) {
    const c = byControl.get(a.control_id as string);
    if (!c) continue;
    c.confirmed_count += 1;
    const column = a.kind === 'probe' ? 'native' : a.kind === 'feed' ? 'feed' : a.manual_kind === 'attestation_statement' ? 'self_attested' : 'manual_file';
    c.columns[column] += 1;
    if (a.outcome) {
      c.assertions.push({
        assertion_id: a.assertion_id as string,
        kind: a.kind as 'probe' | 'manual' | 'feed',
        outcome: a.outcome as 'pass' | 'fail' | 'unprovable',
        unprovable_reason: (a.unprovable_reason as string | null) ?? null,
        cited_refs: (a.cited_refs as CitedRef[]) ?? [],
      });
      const exp = (a.summary as Record<string, unknown> | null)?.expires_at;
      if (a.kind === 'manual' && a.outcome === 'pass' && typeof exp === 'string') {
        const d = new Date(exp);
        if (!c.manual_expires_at || d.getTime() < c.manual_expires_at.getTime()) c.manual_expires_at = d;
      }
    }
  }
  const exRows: ExceptionRow[] = exceptions.map((e) => ({
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
  const list = [...byControl.values()];
  for (const c of list) c.verdict = verdictOf(c, exRows, stale, now);
  return {
    controls: list,
    exceptions: exRows,
    stale_after_hours: stale,
    not_applicable: notApplicable.map((r) => ({ control_id: r.id as string, control_key: r.control_key as string, title: r.title as string })),
  };
}

/** The coverage kind shown on the Evidence map, from the source columns. */
export function coverageOfColumns(columns: ControlState['columns']) {
  const kinds: Array<'probe' | 'feed' | 'manual' | 'self_attested'> = [];
  if (columns.native > 0) kinds.push('probe');
  if (columns.feed > 0) kinds.push('feed');
  if (columns.manual_file > 0) kinds.push('manual');
  if (columns.self_attested > 0) kinds.push('self_attested');
  return coverageKindOf(kinds);
}

export async function loadReadinessNumbers(tx: Tx, orgId: string, now: Date, frameworkId?: string): Promise<ReadinessNumbers> {
  const s = await loadControlStates(tx, orgId, now, frameworkId);
  return computeNumbers(s.controls, s.exceptions, s.stale_after_hours, now);
}
