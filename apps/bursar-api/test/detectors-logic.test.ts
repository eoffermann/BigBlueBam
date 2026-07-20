import { describe, it, expect } from 'vitest';
import {
  selectAwardForSpend,
  matchSpendLine,
  evaluatePriceDrift,
  invoicedScopeDivergence,
  silentLineDivergence,
  detectUnbaselinedVendors,
  currentRenewalBand,
  bandsToAlert,
  type BaselineLine,
  type AwardTerm,
  type SpendLine,
} from '../src/services/engines/detectors-logic.js';

const baseline = (over: Partial<BaselineLine> = {}): BaselineLine => ({
  id: 'b1',
  award_id: 'a1',
  title: 'Managed backups',
  kind: 'included',
  currency: 'USD',
  unit_price_minor: 100_000,
  quantity: '1',
  extended_minor: 100_000,
  ...over,
});

const spend = (over: Partial<SpendLine> = {}): SpendLine => ({
  id: 's1',
  normalized_payee: 'ACME',
  vendor_id: 'v1',
  occurred_on: '2026-06-01',
  amount_minor: 100_000,
  currency: 'USD',
  ...over,
});

describe('selectAwardForSpend (null terms)', () => {
  const award = (over: Partial<AwardTerm>): AwardTerm => ({
    id: 'a',
    term_start: null,
    term_end: null,
    awarded_at: '2026-01-01T00:00:00Z',
    currency: 'USD',
    ...over,
  });

  it('prefers a bounded award covering the date (exact)', () => {
    const bounded = award({ id: 'bounded', term_start: '2026-01-01', term_end: '2026-12-31' });
    const open = award({ id: 'open', term_start: '2025-01-01', term_end: null });
    const sel = selectAwardForSpend([bounded, open], '2026-06-01');
    expect(sel?.award.id).toBe('bounded');
    expect(sel?.match_method).toBe('exact');
  });

  it('selects an open-ended award when occurred_on >= term_start and no bounded award matches', () => {
    const open = award({ id: 'open', term_start: '2025-01-01', term_end: null });
    const sel = selectAwardForSpend([open], '2026-06-01');
    expect(sel?.award.id).toBe('open');
    expect(sel?.match_method).toBe('exact');
  });

  it('selects a both-null open-ended award unconditionally', () => {
    const open = award({ id: 'open', term_start: null, term_end: null });
    expect(selectAwardForSpend([open], '2000-01-01')?.award.id).toBe('open');
  });

  it('picks the most recent and records fuzzy on ambiguity', () => {
    const older = award({ id: 'older', term_start: '2025-01-01', term_end: '2027-01-01' });
    const newer = award({ id: 'newer', term_start: '2026-01-01', term_end: '2027-01-01' });
    const sel = selectAwardForSpend([older, newer], '2026-06-01');
    expect(sel?.award.id).toBe('newer');
    expect(sel?.match_method).toBe('fuzzy');
  });

  it('returns null when nothing covers the date', () => {
    const bounded = award({ id: 'bounded', term_start: '2020-01-01', term_end: '2020-12-31' });
    expect(selectAwardForSpend([bounded], '2026-06-01')).toBeNull();
  });
});

describe('matchSpendLine (deterministic only)', () => {
  it('matches exact title', () => {
    const m = matchSpendLine(spend(), 'Managed Backups', [baseline()]);
    expect(m?.method).toBe('exact');
  });

  it('matches by trigram above the floor', () => {
    const m = matchSpendLine(spend(), 'Managed backup service', [baseline()]);
    expect(m?.method).toBe('trigram');
  });

  it('matches by unit-price equality within tolerance when title differs', () => {
    const m = matchSpendLine(spend({ amount_minor: 100_000 }), 'Totally unrelated', [baseline()]);
    expect(m?.method).toBe('unit_price');
  });

  it('returns null when nothing matches', () => {
    const m = matchSpendLine(spend({ amount_minor: 999 }), 'zzz', [baseline({ title: 'qqq' })]);
    expect(m).toBeNull();
  });

  it('never matches an excluded/absent baseline item', () => {
    const m = matchSpendLine(spend(), 'Managed Backups', [baseline({ kind: 'excluded_at_award' })]);
    expect(m).toBeNull();
  });
});

describe('evaluatePriceDrift (currency guard + computed dollars)', () => {
  it('skips with currency_mismatch when currencies differ (no drift computed)', () => {
    const out = evaluatePriceDrift(spend({ currency: 'EUR' }), baseline({ currency: 'USD' }));
    expect(out.result).toBe('skip');
    if (out.result === 'skip') expect(out.reason).toBe('currency_mismatch');
  });

  it('fires when deviation >= threshold AND absolute >= $25, with computed overage', () => {
    // Baseline $1000, observed $1200 -> +20%, +$200.
    const out = evaluatePriceDrift(spend({ amount_minor: 120_000 }), baseline());
    expect(out.result).toBe('drift');
    if (out.result === 'drift') {
      expect(out.deviation_pct).toBe(20);
      expect(out.dollars_at_stake_minor).toBe(20_000);
    }
  });

  it('does NOT fire below the percent threshold', () => {
    // +5% is under the 10% default.
    expect(evaluatePriceDrift(spend({ amount_minor: 105_000 }), baseline()).result).toBe('no_drift');
  });

  it('does NOT fire when the absolute difference is under $25 even if percent is large', () => {
    // Baseline $2.00, observed $2.20 -> +10% but only +$0.20.
    const out = evaluatePriceDrift(
      spend({ amount_minor: 220 }),
      baseline({ unit_price_minor: 200, extended_minor: 200 }),
    );
    expect(out.result).toBe('no_drift');
  });

  it('does not compute drift when the baseline has no price', () => {
    const out = evaluatePriceDrift(spend(), baseline({ unit_price_minor: null, extended_minor: null }));
    expect(out.result).toBe('no_drift');
  });
});

describe('scope_divergence', () => {
  it('invoiced-unbaselined stakes the whole spend amount (computed)', () => {
    const f = invoicedScopeDivergence(spend({ amount_minor: 4_200 }));
    expect(f.kind).toBe('invoiced_unbaselined');
    expect(f.dollars_at_stake_minor).toBe(4_200);
  });

  it('silent line on a bounded elapsed term states elapsed_term basis, null dollars', () => {
    const award: AwardTerm = {
      id: 'a',
      term_start: '2024-01-01',
      term_end: '2024-12-31',
      awarded_at: '2024-01-01T00:00:00Z',
      currency: 'USD',
    };
    const f = silentLineDivergence(baseline(), award, '2026-06-01');
    expect(f?.basis).toBe('elapsed_term');
    expect(f?.dollars_at_stake_minor).toBeNull();
  });

  it('does NOT evaluate a silent line while a bounded term is still running', () => {
    const award: AwardTerm = {
      id: 'a',
      term_start: '2026-01-01',
      term_end: '2026-12-31',
      awarded_at: '2026-01-01T00:00:00Z',
      currency: 'USD',
    };
    expect(silentLineDivergence(baseline(), award, '2026-06-01')).toBeNull();
  });

  it('silent line on an open-ended award uses the rolling_12mo basis', () => {
    const award: AwardTerm = {
      id: 'a',
      term_start: '2024-01-01',
      term_end: null,
      awarded_at: '2024-01-01T00:00:00Z',
      currency: 'USD',
    };
    expect(silentLineDivergence(baseline(), award, '2026-06-01')?.basis).toBe('rolling_12mo');
  });
});

describe('detectUnbaselinedVendors (grouped by normalized_payee)', () => {
  it('fires on >= 2 events in 180d for a payee, grouped by normalized_payee (vendor_id NULL)', () => {
    const events: SpendLine[] = [
      spend({ id: 'e1', vendor_id: null, normalized_payee: 'SHADOW SAAS', occurred_on: '2026-05-01', amount_minor: 1_000 }),
      spend({ id: 'e2', vendor_id: null, normalized_payee: 'SHADOW SAAS', occurred_on: '2026-06-01', amount_minor: 1_500 }),
      spend({ id: 'e3', vendor_id: null, normalized_payee: 'ONE OFF', occurred_on: '2026-06-01', amount_minor: 9_000 }),
    ];
    const out = detectUnbaselinedVendors(events, '2026-06-15');
    expect(out).toHaveLength(1);
    expect(out[0]!.normalized_payee).toBe('SHADOW SAAS');
    expect(out[0]!.event_count).toBe(2);
    expect(out[0]!.dollars_at_stake_minor).toBe(2_500); // computed sum
  });

  it('ignores events outside the 180d window', () => {
    const events: SpendLine[] = [
      spend({ id: 'e1', vendor_id: null, normalized_payee: 'OLD', occurred_on: '2025-01-01' }),
      spend({ id: 'e2', vendor_id: null, normalized_payee: 'OLD', occurred_on: '2026-06-01' }),
    ];
    expect(detectUnbaselinedVendors(events, '2026-06-15')).toHaveLength(0);
  });
});

describe('renewal bands', () => {
  it('reports the tightest band the deadline sits inside', () => {
    expect(currentRenewalBand('2026-08-01', '2026-06-01')).toBe('t_minus_90'); // ~61d out
    expect(currentRenewalBand('2026-06-20', '2026-06-01')).toBe('t_minus_30'); // 19d out
    expect(currentRenewalBand('2026-06-05', '2026-06-01')).toBe('t_minus_7'); // 4d out
    expect(currentRenewalBand('2026-12-01', '2026-06-01')).toBeNull(); // >90d out
    expect(currentRenewalBand('2026-05-01', '2026-06-01')).toBeNull(); // past
  });

  it('alerts every band at or tighter than current not already alerted (idempotent)', () => {
    expect(bandsToAlert('t_minus_30', [])).toEqual(['t_minus_90', 't_minus_60', 't_minus_30']);
    expect(bandsToAlert('t_minus_30', ['t_minus_90', 't_minus_60'])).toEqual(['t_minus_30']);
    expect(bandsToAlert('t_minus_30', ['t_minus_90', 't_minus_60', 't_minus_30'])).toEqual([]);
    expect(bandsToAlert(null, [])).toEqual([]);
  });
});
