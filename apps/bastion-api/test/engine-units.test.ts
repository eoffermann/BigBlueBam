import { describe, expect, it } from 'vitest';
import { BASTION_PROBE_KEYS, bastionEvaluateRunJobId, type BastionProbeResult } from '@bigbluebam/shared';
import {
  ENGINE_TIMEOUT_MS,
  EVALUATE_MAX_POLLS,
  EVALUATE_POLL_INTERVAL_MS,
  LEDGER_LOCK_TIMEOUT_MS,
  LLM_CALL_TIMEOUT_MS,
  LLM_SLICE_START_CUTOFF_MS,
  PROBE_TIMEOUT_MS,
  PUT_TIMEOUT_MS,
  RUN_LEASE_MS,
  SLICE_START_CUTOFF_MS,
  worstCaseProbeSliceMs,
} from '../src/engine/budgets.js';
import { replicaLagMs } from '../src/engine/read-scope.js';
import { nextBackoffMs, OUTBOX_MAX_ATTEMPTS, OUTBOX_MAX_DELAY_MS, enqueueBastionEvent } from '../src/engine/outbox.js';
import { localClock } from '../src/engine/context.js';
import { nightlyDue } from '../src/engine/sweeps.js';
import { decide, probeDefinition, PROBES, probeWindow } from '../src/probes/definitions.js';
import { sqlParams } from '../src/probes/run-probe.js';

describe('time budgets (spec 7.3)', () => {
  it('12 + probe timeout + write budget < engine timeout', () => {
    expect(SLICE_START_CUTOFF_MS).toBe(12_000);
    expect(PROBE_TIMEOUT_MS + PUT_TIMEOUT_MS + LEDGER_LOCK_TIMEOUT_MS).toBe(16_000);
    expect(worstCaseProbeSliceMs()).toBe(28_000);
    expect(worstCaseProbeSliceMs()).toBeLessThan(ENGINE_TIMEOUT_MS);
  });

  it('an LLM slice fits inside the run lease', () => {
    expect(LLM_SLICE_START_CUTOFF_MS + LLM_CALL_TIMEOUT_MS).toBeLessThan(RUN_LEASE_MS);
  });

  it('the evaluate-run poll cap covers 90 minutes', () => {
    expect(EVALUATE_POLL_INTERVAL_MS * EVALUATE_MAX_POLLS).toBe(90 * 60_000);
  });

  it('evaluate-run job ids carry resume_count and are valid BullMQ custom ids', () => {
    const id = bastionEvaluateRunJobId('00000000-0000-4000-8000-000000000001', 2);
    expect(id).toBe('00000000-0000-4000-8000-000000000001-r2');
    expect(id.includes(':')).toBe(false);
    expect(bastionEvaluateRunJobId('x', 2, 5)).toBe('x-r2-g5');
  });
});

describe('replica lag (spec 3.1)', () => {
  it('a NULL replay timestamp (the read URL is a primary) counts as zero lag', () => {
    expect(replicaLagMs(new Date('2026-11-26T03:00:00Z'), null)).toBe(0);
  });
  it('lag is as_of minus the last replay, never negative', () => {
    expect(replicaLagMs(new Date('2026-11-26T03:00:40Z'), new Date('2026-11-26T03:00:00Z'))).toBe(40_000);
    expect(replicaLagMs(new Date('2026-11-26T03:00:00Z'), new Date('2026-11-26T03:00:05Z'))).toBe(0);
  });
});

describe('outbox backoff (spec 7)', () => {
  it('30 s doubling, capped at 6 h, then dead', () => {
    expect(nextBackoffMs(1)).toBe(30_000);
    expect(nextBackoffMs(2)).toBe(60_000);
    expect(nextBackoffMs(OUTBOX_MAX_ATTEMPTS - 1)).toBe(OUTBOX_MAX_DELAY_MS);
    expect(nextBackoffMs(OUTBOX_MAX_ATTEMPTS)).toBeNull();
  });

  it('enqueueBastionEvent refuses a name outside BASTION_EVENT_TYPES', async () => {
    const tx = (() => Promise.resolve([])) as never;
    await expect(enqueueBastionEvent('not.an.event' as never, {}, tx, { orgId: 'o', idempotencyKey: 'k' })).rejects.toThrow(/unknown Bastion event/);
  });
});

describe('nightly schedule (spec 7)', () => {
  it('reads the local clock in the org timezone', () => {
    expect(localClock(new Date('2026-11-26T08:30:00Z'), 'America/Los_Angeles')).toEqual({ date: '2026-11-26', minutes: 30 });
    expect(localClock(new Date('2026-11-26T08:30:00Z'), 'Not/AZone')).toEqual({ date: '2026-11-26', minutes: 8 * 60 + 30 });
  });

  it('is due from the org slot (hour plus its minute offset) onwards, on the local date', () => {
    const org = { timezone: 'America/Los_Angeles', evaluation_hour_local: 3, evaluation_minute_offset: 17 };
    expect(nightlyDue(new Date('2026-11-26T11:10:00Z'), org)).toEqual({ due: false, nightly_for_date: '2026-11-26' });
    expect(nightlyDue(new Date('2026-11-26T11:17:00Z'), org)).toEqual({ due: true, nightly_for_date: '2026-11-26' });
  });
});

const result = (over: Partial<BastionProbeResult> & { summary?: Record<string, unknown> }): BastionProbeResult => ({
  probe_key: 'keys.max_age',
  probe_version: 1,
  as_of: '2026-11-26T03:00:00Z',
  summary: {},
  cited_refs: [],
  cited_count: 0,
  overflow_count: 0,
  ...over,
});

describe('probe modules (spec 3.1)', () => {
  it('every probe key in the shared enum has a module', () => {
    for (const k of BASTION_PROBE_KEYS) expect(PROBES.has(k), k).toBe(true);
    expect(PROBES.size).toBe(BASTION_PROBE_KEYS.length);
  });

  it('params are passed without the people-facing population bookkeeping', () => {
    expect(sqlParams({ window_days: 30, expected_population: ['a/b'], population_labels: { 'a/b': 'A' }, population_confirmed_by: 'x' })).toEqual({
      window_days: 30,
      expected_population: ['a/b'],
    });
  });

  it('explain() is counts-only unless detail is allowed, and names the population only with detail', () => {
    const def = probeDefinition('change.merge_reviewed')!;
    const r = result({
      probe_key: 'change.merge_reviewed',
      summary: { merges: 3, unreviewed_merges: 1, window_days: 90, repos: [{ repo: 'skipper/lagoon-booking-site', reviews_subscribed: true }] },
      cited_refs: [{ entity_type: 'github_pr_event', entity_id: '00000000-0000-4000-8000-000000000042' }],
      cited_count: 1,
      population_checked: ['skipper/lagoon-booking-site'],
      population_unlisted: [],
      population_missing: [],
    });
    const plain = def.explain(r, false);
    expect(plain).not.toContain('00000000-0000-4000-8000-000000000042');
    expect(plain).not.toContain('lagoon');
    expect(plain).toContain('1 repository');
    expect(def.explain(r, true)).toContain('skipper/lagoon-booking-site');
    for (const p of PROBES.values()) {
      const text = p.explain(result({ probe_key: p.key, cited_refs: r.cited_refs, cited_count: 1 }), false);
      expect(text, p.key).not.toContain('00000000-0000-4000-8000-000000000042');
    }
  });

  it('subscribed_events NULL is unknown: zero-approval merges still fail, with the ping note', () => {
    const def = probeDefinition('change.merge_reviewed')!;
    const r = result({
      probe_key: 'change.merge_reviewed',
      summary: { merges: 2, unreviewed_merges: 2, window_days: 90, repos: [{ repo: 'skipper/lagoon-booking-site', reviews_subscribed: null }] },
      cited_count: 2,
      population_checked: ['skipper/lagoon-booking-site'],
      population_unlisted: [],
      population_missing: [],
    });
    expect(decide(def, r, {})).toEqual({ outcome: 'fail' });
    expect(def.explain(r, false)).toContain('click Redeliver on the ping');
  });

  it('a known subscription list without review events is source_not_connected', () => {
    const def = probeDefinition('change.merge_reviewed')!;
    const r = result({
      probe_key: 'change.merge_reviewed',
      summary: { merges: 2, unreviewed_merges: 0, repos: [{ repo: 'x/y', reviews_subscribed: false }] },
      population_checked: ['x/y'],
      population_missing: [],
    });
    expect(decide(def, r, {})).toEqual({ outcome: 'unprovable', reason: 'source_not_connected' });
  });

  it('a listed repository that is not connected is source_not_connected; unlisted ones do not change the outcome', () => {
    const def = probeDefinition('change.merge_traceable')!;
    const missing = result({ probe_key: 'change.merge_traceable', summary: { merges: 5, untraced_merges: 0 }, population_checked: ['a/b', 'c/d'], population_missing: ['c/d'] });
    expect(decide(def, missing, {})).toEqual({ outcome: 'unprovable', reason: 'source_not_connected' });
    const unlisted = result({ probe_key: 'change.merge_traceable', summary: { merges: 10, untraced_merges: 1 }, population_checked: ['a/b'], population_missing: [], population_unlisted: ['coral/reef-booking'] });
    expect(decide(def, unlisted, {})).toEqual({ outcome: 'pass' });
    expect(decide(def, unlisted, { min_ratio: 0.95 })).toEqual({ outcome: 'fail' });
  });

  it('thresholds and insufficient data', () => {
    expect(decide(probeDefinition('automation.failure_rate')!, result({ summary: { executions: 0, failed: 0 } }), {})).toEqual({ outcome: 'unprovable', reason: 'insufficient_data' });
    expect(decide(probeDefinition('automation.failure_rate')!, result({ summary: { executions: 100, failed: 6 } }), {})).toEqual({ outcome: 'fail' });
    expect(decide(probeDefinition('access.privileged_roster')!, result({ summary: { over_limit: true } }), {})).toEqual({ outcome: 'fail' });
    expect(decide(probeDefinition('ops.backup_fresh')!, result({ summary: { offsite_backup_configured: false } }), {})).toEqual({ outcome: 'unprovable', reason: 'source_not_connected' });
    expect(decide(probeDefinition('ops.backup_fresh')!, result({ summary: { offsite_backup_configured: true, completed_backups: 0 } }), {})).toEqual({ outcome: 'fail' });
    expect(decide(probeDefinition('policy.attested')!, result({ summary: { policy_found: false } }), {})).toEqual({ outcome: 'unprovable', reason: 'no_evidence_source' });
  });

  it('the window comes from the probe\'s own window_days', () => {
    const w = probeWindow(result({ summary: { window_days: 30 } }), new Date('2026-11-26T03:00:00Z'));
    expect(w.start?.toISOString()).toBe('2026-10-27T03:00:00.000Z');
  });
});
