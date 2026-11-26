// Pure status rules (spec 2.2, 2.3, 3.2). No I/O: the evaluator and every reader call these.

import {
  BASTION_EFFECTIVE_STATE_SEVERITY,
  type BastionAssertionKind,
  type BastionCoverageKind,
  type BastionEffectiveState,
  type BastionStoredStatus,
  type BastionUnprovableReason,
} from '@bigbluebam/shared';

export const STORED_RANK: Record<BastionStoredStatus, number> = { pass: 0, unprovable: 1, fail: 2 };

export interface SnapshotOutcome {
  outcome: BastionStoredStatus;
  unprovable_reason: string | null;
}

export interface Aggregate {
  status: BastionStoredStatus;
  reason: string | null;
  /** Some assertion could not run (probe_error): the stored status must not drift on this run. */
  infra: boolean;
}

/** Worst of the assertions: fail > unprovable > pass (spec 2.2). probe_error marks infra. */
export function aggregateStored(rows: SnapshotOutcome[]): Aggregate {
  let status: BastionStoredStatus = 'pass';
  let reason: string | null = null;
  let infra = false;
  for (const r of rows) {
    if (r.outcome === 'unprovable' && r.unprovable_reason === 'probe_error') {
      infra = true;
      continue;
    }
    if (STORED_RANK[r.outcome] > STORED_RANK[status]) {
      status = r.outcome;
      reason = r.outcome === 'unprovable' ? r.unprovable_reason : null;
    }
  }
  if (rows.length === 0) return { status: 'unprovable', reason: 'not_yet_confirmed', infra: false };
  return { status, reason, infra };
}

export function isWorsening(from: BastionStoredStatus, to: BastionStoredStatus): boolean {
  return STORED_RANK[to] > STORED_RANK[from];
}

export interface ControlErrorState {
  status: BastionStoredStatus;
  status_reason: string | null;
  consecutive_error_nights: number;
  last_error_night: string | null;
}

export interface InfraDecision {
  consecutive_error_nights: number;
  last_error_night: string | null;
  /** Only the second distinct night changes status (to unprovable / probe_error). */
  status: BastionStoredStatus;
  status_reason: string | null;
  status_changed: boolean;
}

/**
 * The two-night probe_error rule (spec 3.2): count distinct nightly_for_date values with a
 * probe_error; manual runs never count; only the second distinct night changes status.
 */
export function infraDecision(control: ControlErrorState, nightlyForDate: string | null): InfraDecision {
  let nights = control.consecutive_error_nights;
  let lastNight = control.last_error_night;
  if (nightlyForDate !== null && lastNight !== nightlyForDate) {
    nights += 1;
    lastNight = nightlyForDate;
  }
  if (nights >= 2) {
    const changed = !(control.status === 'unprovable' && control.status_reason === 'probe_error');
    return { consecutive_error_nights: nights, last_error_night: lastNight, status: 'unprovable', status_reason: 'probe_error', status_changed: changed };
  }
  return {
    consecutive_error_nights: nights,
    last_error_night: lastNight,
    status: control.status,
    status_reason: control.status_reason,
    status_changed: false,
  };
}

/** coverage_kind from the kinds of a control's confirmed assertions. */
export function coverageKindOf(kinds: BastionAssertionKind[]): BastionCoverageKind {
  const mapped = new Set(kinds.map((k) => (k === 'probe' ? 'native' : k === 'feed' ? 'feed' : 'manual_file')));
  if (mapped.size === 0) return 'none';
  if (mapped.size === 1) return [...mapped][0] as BastionCoverageKind;
  return 'mixed';
}

// ── effectiveStatus (spec 3.2) ─────────────────────────────────────────────────────────

export interface CitedRef {
  entity_type: string;
  entity_id: string;
}

export interface AssertionLatest {
  assertion_id: string;
  outcome: BastionStoredStatus;
  unprovable_reason: string | null;
  cited_refs: CitedRef[];
}

export interface ExceptionRow {
  id: string;
  /** Set when a caller passes exceptions for several controls at once. */
  control_id?: string;
  scope: 'entity' | 'assertion';
  assertion_id: string | null;
  cited_entity_type: string | null;
  cited_entity_id: string | null;
  frozen_refs: CitedRef[] | null;
  status: string;
  expires_at: Date;
}

export interface EffectiveInput {
  last_evaluated_at: Date | null;
  stale_after_hours: number;
  assertions: AssertionLatest[];
  exceptions: ExceptionRow[];
}

export interface EffectiveAssertion {
  assertion_id: string;
  state: BastionEffectiveState;
  reason: BastionUnprovableReason | null;
  exception_ids: string[];
}

export interface Effective {
  state: BastionEffectiveState;
  reason: BastionUnprovableReason | null;
  assertions: EffectiveAssertion[];
}

const sameRef = (a: CitedRef, b: CitedRef) => a.entity_type === b.entity_type && a.entity_id === b.entity_id;

function coveringExceptions(a: AssertionLatest, exceptions: ExceptionRow[], now: Date): string[] | null {
  const live = exceptions.filter((e) => e.status === 'active' && e.expires_at.getTime() > now.getTime());
  const forAssertion = live.filter((e) => e.scope === 'assertion' && e.assertion_id === a.assertion_id);
  const forEntity = live.filter((e) => e.scope === 'entity' && (e.assertion_id === null || e.assertion_id === a.assertion_id));
  if (a.cited_refs.length === 0) {
    // A counts-only failure can only be covered by a whole-assertion exception.
    return forAssertion.length > 0 ? forAssertion.map((e) => e.id) : null;
  }
  const used = new Set<string>();
  for (const ref of a.cited_refs) {
    const ent = forEntity.find((e) => e.cited_entity_type === ref.entity_type && e.cited_entity_id === ref.entity_id);
    if (ent) {
      used.add(ent.id);
      continue;
    }
    // A whole-assertion exception covers only the refs frozen when it was approved, so a new
    // failure after approval is not silently accepted.
    const asr = forAssertion.find((e) => (e.frozen_refs ?? []).some((f) => sameRef(f, ref)));
    if (asr) {
      used.add(asr.id);
      continue;
    }
    return null;
  }
  return [...used];
}

/**
 * The only way any reader obtains a status. Staleness first; then per assertion (a failure fully
 * covered by active exceptions becomes pass_with_exception); then the worst over the assertions
 * in the order fail > unprovable > pass_with_exception > pass.
 */
export function effectiveStatus(input: EffectiveInput, now: Date): Effective {
  if (input.assertions.length === 0) {
    return { state: 'unprovable', reason: 'not_yet_confirmed', assertions: [] };
  }
  const staleMs = input.stale_after_hours * 3_600_000;
  if (input.last_evaluated_at === null || now.getTime() - input.last_evaluated_at.getTime() > staleMs) {
    return { state: 'unprovable', reason: 'evaluation_stale', assertions: [] };
  }
  const per: EffectiveAssertion[] = input.assertions.map((a) => {
    if (a.outcome === 'fail') {
      const covering = coveringExceptions(a, input.exceptions, now);
      if (covering) return { assertion_id: a.assertion_id, state: 'pass_with_exception', reason: null, exception_ids: covering };
      return { assertion_id: a.assertion_id, state: 'fail', reason: null, exception_ids: [] };
    }
    if (a.outcome === 'unprovable') {
      return { assertion_id: a.assertion_id, state: 'unprovable', reason: (a.unprovable_reason ?? 'no_evidence_source') as BastionUnprovableReason, exception_ids: [] };
    }
    return { assertion_id: a.assertion_id, state: 'pass', reason: null, exception_ids: [] };
  });
  let worst = per[0] as EffectiveAssertion;
  for (const p of per) {
    if (BASTION_EFFECTIVE_STATE_SEVERITY[p.state] > BASTION_EFFECTIVE_STATE_SEVERITY[worst.state]) worst = p;
  }
  return { state: worst.state, reason: worst.reason, assertions: per };
}
