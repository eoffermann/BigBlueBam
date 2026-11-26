import { describe, it, expect } from 'vitest';
import { planCompile, validateManualSuggestion, validateProbeSuggestion, type ConnectedPopulations } from '../src/library/compile-plan.js';
import { templateControlKeys } from '../src/library/index.js';
import { SOC2 } from '../src/library/soc2.js';
import { ISO27001 } from '../src/library/iso27001.js';

// Spec 11.1: compiler validation (unknown probe key, out-of-range threshold dropped) and the
// deterministic fallback (library suggestions proposed verbatim, population from the connected set).

const NONE: ConnectedPopulations = { github_repos: [], blip_apps: [] };
const REPOS: ConnectedPopulations = {
  github_repos: [
    { value: 'castaways/rescue-radio-firmware', label: 'castaways/rescue-radio-firmware' },
    { value: 'castaways/lagoon-booking-site', label: 'castaways/lagoon-booking-site' },
  ],
  blip_apps: [{ value: '00000000-0000-4000-8000-000000000001', label: 'Daily Coconut Count' }],
};

describe('validateProbeSuggestion', () => {
  it('drops an unknown probe key with a recorded reason', () => {
    const v = validateProbeSuggestion({ probe_key: 'mfa.everyone' as never, plain_statement: 'x' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/unknown probe/);
  });

  it('drops an out-of-range parameter', () => {
    const v = validateProbeSuggestion({ probe_key: 'keys.max_age', params: { max_age_days: 99999 }, plain_statement: 'x' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/parameters out of range/);
  });

  it('drops an unknown parameter key (the probe schemas are strict)', () => {
    const v = validateProbeSuggestion({ probe_key: 'keys.max_age', params: { drop_table: 1 }, plain_statement: 'x' });
    expect(v.ok).toBe(false);
  });

  it('drops an out-of-range threshold', () => {
    const v = validateProbeSuggestion({
      probe_key: 'automation.failure_rate',
      predicate: { max_failure_ratio: 0.9 },
      plain_statement: 'x',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/threshold out of range/);
  });

  it('accepts an in-range suggestion and pins the probe version', () => {
    const v = validateProbeSuggestion({ probe_key: 'keys.max_age', params: { max_age_days: 120 }, plain_statement: 'x' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toMatchObject({ kind: 'probe', probe_key: 'keys.max_age', probe_version: 1 });
  });

  it('proposes a population probe with the connected set and its labels', () => {
    const v = validateProbeSuggestion({ probe_key: 'change.merge_reviewed', plain_statement: 'x' }, REPOS);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.params.expected_population).toEqual(REPOS.github_repos.map((m) => m.value));
      expect(v.value.params.population_labels).toEqual({
        'castaways/rescue-radio-firmware': 'castaways/rescue-radio-firmware',
        'castaways/lagoon-booking-site': 'castaways/lagoon-booking-site',
      });
      // Proposed, never pre-confirmed: a person must say "This is the complete list".
      expect(v.value.params.population_confirmed_at).toBeUndefined();
    }
  });
});

describe('validateManualSuggestion', () => {
  it('drops a malformed manual request', () => {
    const v = validateManualSuggestion({
      spec: { title: '', description: 'x', kind: 'file', cadence_days: 0 },
      plain_statement: 'x',
    });
    expect(v.ok).toBe(false);
  });
});

describe('planCompile (deterministic fallback)', () => {
  it('proposes every library suggestion for every SOC 2 control with nothing dropped', () => {
    const keys = templateControlKeys(SOC2);
    const plan = planCompile(keys, [], NONE);
    expect(plan.dropped).toEqual([]);
    expect(plan.controls_total).toBe(keys.length);
    const controlsWithProposal = new Set(plan.planned.map((p) => p.control_key));
    expect([...controlsWithProposal].sort()).toEqual([...keys].sort());
  });

  it('gives every ISO control an assertion or a manual request (compiler coverage gate, spec 11.3)', () => {
    const keys = templateControlKeys(ISO27001);
    const plan = planCompile(keys, [], REPOS);
    expect(new Set(plan.planned.map((p) => p.control_key)).size).toBe(keys.length);
  });

  it('does not propose a duplicate for a control that already has a live assertion of the same shape', () => {
    const existing = [
      { control_key: 'keys.rotation', kind: 'probe', probe_key: 'keys.max_age', manual_title: null, review_status: 'confirmed' },
      { control_key: 'auth.mfa', kind: 'manual', probe_key: null, manual_title: 'Two-step sign-in report', review_status: 'proposed' },
      // A rejected assertion does not block a fresh proposal.
      { control_key: 'keys.rotation', kind: 'probe', probe_key: 'keys.unused_active', manual_title: null, review_status: 'rejected' },
    ];
    const plan = planCompile(['keys.rotation', 'auth.mfa'], existing, NONE);
    expect(plan.planned.map((p) => `${p.control_key}:${p.probe_key ?? p.manual_evidence_spec?.title}`)).toEqual([
      'keys.rotation:keys.unused_active',
    ]);
    expect(plan.skipped_existing).toBe(2);
  });

  it('records a drop reason instead of failing the run when a suggestion is invalid', () => {
    const plan = planCompile(['keys.rotation'], [], NONE, {
      probe: () => [
        { probe_key: 'keys.max_age', params: { max_age_days: 0 }, plain_statement: 'bad' },
        { probe_key: 'keys.unused_active', plain_statement: 'good' },
      ],
    });
    expect(plan.planned).toHaveLength(1);
    expect(plan.dropped).toHaveLength(1);
    expect(plan.dropped[0]!.reason).toMatch(/out of range/);
  });

  it('skips custom controls, which have no library suggestions', () => {
    expect(planCompile(['custom:island-radio'], [], NONE).planned).toEqual([]);
  });
});
