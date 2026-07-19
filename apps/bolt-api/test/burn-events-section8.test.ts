import { describe, it, expect } from 'vitest';
import { getEventsBySource } from '../src/services/event-catalog.js';
import { isBurnSubscribed, BURN_SUBSCRIPTION_COUNT } from '../src/services/burn-subscriptions.js';

/**
 * §12.1 assertions for Section 8 (events + subscriptions). The security invariant is that a Burn
 * Bolt payload carries refs + coarse bands ONLY - no dollar amount and no percentage - because
 * Bolt is org-level with no per-rule visibility (spec 2.4 point 13). And the dispatch hook must
 * forward ONLY the 16 subscribed (source, event_type) pairs (spec 8.3).
 */

describe('§8 the ten burn events are registered and refs-only', () => {
  const events = getEventsBySource('burn');

  it('registers exactly the ten burn events', () => {
    expect(events).toHaveLength(10);
    const names = events.map((e) => e.event_type).sort();
    expect(names).toEqual([
      'consumption.threshold_crossed',
      'deliverable.extracted',
      'deliverable.silent',
      'engagement.extracted',
      'gate.coverage_degraded',
      'gate.demoted',
      'precheck.blocked',
      'precheck.overridden',
      'variance.detected',
      'work.unscoped',
    ]);
  });

  it('no burn event payload field is a dollar amount or a raw percentage', () => {
    // A coarse `band` / `coverage_pct_band` string is allowed; a raw amount or pct field is not.
    const forbidden = /(^|[._])(amount|amount_minor|contract_value|margin|margin_pct|cost|revenue)($|[._])/i;
    const forbiddenPct = /(consumption_pct|margin_pct|coverage_pct)$/i; // raw pct fields, not *_band
    for (const ev of events) {
      for (const field of ev.payload_schema) {
        expect(field.name, `${ev.event_type}.${field.name}`).not.toMatch(forbidden);
        // A field literally named *_pct (not *_pct_band) would leak a percentage.
        if (/_pct$/i.test(field.name)) {
          expect(field.name, `${ev.event_type}.${field.name}`).not.toMatch(forbiddenPct);
        }
      }
    }
  });

  it('band-bearing events carry a `band` (or *_pct_band), never the magnitude', () => {
    const workUnscoped = events.find((e) => e.event_type === 'work.unscoped')!;
    expect(workUnscoped.payload_schema.some((f) => f.name === 'band')).toBe(true);
    expect(workUnscoped.payload_schema.some((f) => /amount/i.test(f.name))).toBe(false);
    const coverage = events.find((e) => e.event_type === 'gate.coverage_degraded')!;
    expect(coverage.payload_schema.some((f) => f.name === 'coverage_pct_band')).toBe(true);
  });
});

describe('§8 dispatch-hook subscription filter (spec 8.3)', () => {
  it('forwards the 16 subscribed pairs plus the conditional banter signal', () => {
    // 16 hard subscriptions + banter:message.posted (conditional) = 17 entries in the set.
    expect(BURN_SUBSCRIPTION_COUNT).toBe(17);
  });

  it('subscribes to the money-out and work signals, not to chatty unrelated types', () => {
    expect(isBurnSubscribed('bill', 'expense.created')).toBe(true);
    expect(isBurnSubscribed('bill', 'expense.approved')).toBe(true);
    expect(isBurnSubscribed('bill', 'rate.created')).toBe(true);
    expect(isBurnSubscribed('bill', 'rate.updated')).toBe(true);
    expect(isBurnSubscribed('bam', 'task.completed')).toBe(true);
    expect(isBurnSubscribed('bond', 'deal.won')).toBe(true);
    // Not subscribed: an unrelated type or a wrong source.
    expect(isBurnSubscribed('bam', 'task.deleted')).toBe(false);
    expect(isBurnSubscribed('board', 'shape.created')).toBe(false);
    expect(isBurnSubscribed('burn', 'work.unscoped')).toBe(false); // Burn does not re-ingest its own events
  });
});
