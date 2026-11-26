import { describe, expect, it } from 'vitest';
import {
  aggregateStored,
  coverageKindOf,
  effectiveStatus,
  infraDecision,
  isWorsening,
  type AssertionLatest,
  type ExceptionRow,
} from '../src/engine/status.js';
import { computeNumbers } from '../src/engine/numbers.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const FRESH = new Date('2026-11-26T03:00:00Z');
const ref = (id: string) => ({ entity_type: 'user', entity_id: `00000000-0000-4000-8000-${id.padStart(12, '0')}` });

describe('aggregateStored (spec 2.2)', () => {
  it('worst wins: fail > unprovable > pass', () => {
    expect(aggregateStored([{ outcome: 'pass', unprovable_reason: null }, { outcome: 'unprovable', unprovable_reason: 'insufficient_data' }]).status).toBe('unprovable');
    expect(aggregateStored([{ outcome: 'unprovable', unprovable_reason: 'insufficient_data' }, { outcome: 'fail', unprovable_reason: null }]).status).toBe('fail');
    expect(aggregateStored([{ outcome: 'pass', unprovable_reason: null }])).toEqual({ status: 'pass', reason: null, infra: false });
  });

  it('a probe_error is infrastructure, not a compliance outcome', () => {
    const a = aggregateStored([{ outcome: 'pass', unprovable_reason: null }, { outcome: 'unprovable', unprovable_reason: 'probe_error' }]);
    expect(a.infra).toBe(true);
    expect(a.status).toBe('pass');
  });

  it('worsening is by rank', () => {
    expect(isWorsening('pass', 'fail')).toBe(true);
    expect(isWorsening('unprovable', 'fail')).toBe(true);
    expect(isWorsening('fail', 'pass')).toBe(false);
  });
});

describe('two-night probe_error rule (spec 3.2)', () => {
  const pass = { status: 'pass' as const, status_reason: null, consecutive_error_nights: 0, last_error_night: null };

  it('counts distinct nightly dates, and only the second changes status', () => {
    const n1 = infraDecision(pass, '2026-11-25');
    expect(n1).toMatchObject({ consecutive_error_nights: 1, status: 'pass', status_changed: false });
    const again = infraDecision({ ...pass, consecutive_error_nights: 1, last_error_night: '2026-11-25' }, '2026-11-25');
    expect(again.consecutive_error_nights).toBe(1);
    const n2 = infraDecision({ ...pass, consecutive_error_nights: 1, last_error_night: '2026-11-25' }, '2026-11-26');
    expect(n2).toMatchObject({ consecutive_error_nights: 2, status: 'unprovable', status_reason: 'probe_error', status_changed: true });
  });

  it('manual runs never count', () => {
    expect(infraDecision(pass, null)).toMatchObject({ consecutive_error_nights: 0, status: 'pass' });
  });
});

describe('effectiveStatus (spec 3.2)', () => {
  const failing: AssertionLatest = { assertion_id: 'a1', outcome: 'fail', unprovable_reason: null, cited_refs: [ref('1')] };
  const manualMissing: AssertionLatest = { assertion_id: 'a2', outcome: 'unprovable', unprovable_reason: 'manual_evidence_missing', cited_refs: [] };
  const exception = (over: Partial<ExceptionRow> = {}): ExceptionRow => ({
    id: 'e1',
    scope: 'entity',
    assertion_id: 'a1',
    cited_entity_type: 'user',
    cited_entity_id: ref('1').entity_id,
    frozen_refs: null,
    status: 'active',
    expires_at: new Date('2027-01-01T00:00:00Z'),
    ...over,
  });

  it('staleness takes precedence over everything else', () => {
    const e = effectiveStatus({ last_evaluated_at: new Date('2026-11-24T00:00:00Z'), stale_after_hours: 36, assertions: [failing], exceptions: [] }, NOW);
    expect(e).toMatchObject({ state: 'unprovable', reason: 'evaluation_stale' });
  });

  it('a failure fully covered by an active exception reads pass_with_exception', () => {
    const e = effectiveStatus({ last_evaluated_at: FRESH, stale_after_hours: 36, assertions: [failing], exceptions: [exception()] }, NOW);
    expect(e.state).toBe('pass_with_exception');
    expect(e.assertions[0]?.exception_ids).toEqual(['e1']);
  });

  it('a covered fail plus an unprovable sibling reads Can\'t prove yet, and the sibling keeps its own state', () => {
    const e = effectiveStatus({ last_evaluated_at: FRESH, stale_after_hours: 36, assertions: [failing, manualMissing], exceptions: [exception()] }, NOW);
    expect(e.state).toBe('unprovable');
    expect(e.reason).toBe('manual_evidence_missing');
    expect(e.assertions.map((a) => a.state)).toEqual(['pass_with_exception', 'unprovable']);
  });

  it('an expired exception covers nothing', () => {
    const e = effectiveStatus(
      { last_evaluated_at: FRESH, stale_after_hours: 36, assertions: [failing], exceptions: [exception({ expires_at: new Date('2026-11-01T00:00:00Z') })] },
      NOW,
    );
    expect(e.state).toBe('fail');
  });

  it('a whole-assertion exception covers only its frozen refs, so a new failure is not accepted', () => {
    const two: AssertionLatest = { ...failing, cited_refs: [ref('1'), ref('2')] };
    const asr = exception({ scope: 'assertion', cited_entity_type: null, cited_entity_id: null, frozen_refs: [ref('1')] });
    expect(effectiveStatus({ last_evaluated_at: FRESH, stale_after_hours: 36, assertions: [two], exceptions: [asr] }, NOW).state).toBe('fail');
    expect(effectiveStatus({ last_evaluated_at: FRESH, stale_after_hours: 36, assertions: [failing], exceptions: [asr] }, NOW).state).toBe('pass_with_exception');
  });

  it('no confirmed assertion is "not set up", not stale', () => {
    expect(effectiveStatus({ last_evaluated_at: null, stale_after_hours: 36, assertions: [], exceptions: [] }, NOW)).toMatchObject({
      state: 'unprovable',
      reason: 'not_yet_confirmed',
    });
  });
});

describe('coverage kind and the four numbers (spec 2.3)', () => {
  it('maps assertion kinds to coverage', () => {
    expect(coverageKindOf(['probe', 'probe'])).toBe('native');
    expect(coverageKindOf(['feed'])).toBe('feed');
    expect(coverageKindOf(['probe', 'manual'])).toBe('mixed');
    expect(coverageKindOf([])).toBe('none');
  });

  it('counts proven by the suite, by your evidence, not met (with risk accepted), can\'t prove, and not set up', () => {
    const pass = (id: string, kind: 'probe' | 'manual' = 'probe') => ({ assertion_id: id, kind, outcome: 'pass' as const, unprovable_reason: null, cited_refs: [] });
    const n = computeNumbers(
      [
        { control_id: 'c1', last_evaluated_at: FRESH, confirmed_count: 1, assertions: [pass('a1')] },
        { control_id: 'c2', last_evaluated_at: FRESH, confirmed_count: 2, assertions: [pass('a2'), pass('a3', 'manual')] },
        { control_id: 'c3', last_evaluated_at: FRESH, confirmed_count: 1, assertions: [{ assertion_id: 'a4', kind: 'probe', outcome: 'fail', unprovable_reason: null, cited_refs: [ref('9')] }] },
        { control_id: 'c4', last_evaluated_at: FRESH, confirmed_count: 1, assertions: [{ assertion_id: 'a5', kind: 'probe', outcome: 'fail', unprovable_reason: null, cited_refs: [ref('8')] }] },
        { control_id: 'c5', last_evaluated_at: FRESH, confirmed_count: 1, assertions: [{ assertion_id: 'a6', kind: 'probe', outcome: 'unprovable', unprovable_reason: 'insufficient_data', cited_refs: [] }] },
        { control_id: 'c6', last_evaluated_at: null, confirmed_count: 0, assertions: [] },
      ],
      [
        {
          id: 'x',
          control_id: 'c4',
          scope: 'entity',
          assertion_id: 'a5',
          cited_entity_type: 'user',
          cited_entity_id: ref('8').entity_id,
          frozen_refs: null,
          status: 'active',
          expires_at: new Date('2027-01-01T00:00:00Z'),
        },
      ],
      36,
      NOW,
    );
    expect(n).toEqual({ proven_by_suite: 1, proven_by_evidence: 1, not_met: 2, risk_accepted: 1, cant_prove: 1, not_set_up: 1, checked: 5, total: 6 });
  });
});
