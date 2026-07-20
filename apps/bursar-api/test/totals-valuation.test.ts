import { describe, it, expect } from 'vitest';
import { valueGap, computeTotals, isAdmissibleObservation, type ValuationObservation, type GapForTotal } from '../src/services/engines/totals-logic.js';

describe('valuation ladder with admissibility (spec 10.1)', () => {
  it('rung 1 offer_line: one observation suffices (the vendor is pricing its own option)', () => {
    const r = valueGap({ currency: 'USD', offerLine: { amount_minor: 320000, currency: 'USD' } });
    expect(r.rung).toBe('offer_line');
    expect(r.amount_minor).toBe(320000);
    expect(r.estimated).toBe(false);
  });

  it('rung 2 rival_median REQUIRES >= 2 admissible observations (one observation is not a median)', () => {
    const one: ValuationObservation[] = [{ amount_minor: 300000, currency: 'USD', source: 'rival' }];
    expect(valueGap({ currency: 'USD', rivalObservations: one }).rung).toBe('unvalued');
    const two: ValuationObservation[] = [
      { amount_minor: 300000, currency: 'USD', source: 'rival' },
      { amount_minor: 340000, currency: 'USD', source: 'rival' },
    ];
    const r = valueGap({ currency: 'USD', rivalObservations: two });
    expect(r.rung).toBe('rival_median');
    expect(r.amount_minor).toBe(320000);
  });

  it('a different-currency rival is inadmissible', () => {
    const obs: ValuationObservation[] = [
      { amount_minor: 300000, currency: 'EUR', source: 'rival' },
      { amount_minor: 340000, currency: 'EUR', source: 'rival' },
    ];
    expect(valueGap({ currency: 'USD', rivalObservations: obs }).rung).toBe('unvalued');
    expect(isAdmissibleObservation(obs[0]!, 'USD')).toBe(false);
  });

  it('an equal_split observation is REFUSED for valuation', () => {
    const obs: ValuationObservation[] = [
      { amount_minor: 136700, currency: 'USD', source: 'rival', allocation_method: 'equal_split' },
      { amount_minor: 136700, currency: 'USD', source: 'rival', allocation_method: 'equal_split' },
    ];
    expect(valueGap({ currency: 'USD', rivalObservations: obs }).rung).toBe('unvalued');
    expect(isAdmissibleObservation(obs[0]!, 'USD')).toBe(false);
  });

  it('rung 3 library_unit is estimated; below rung 3 the gap is unvalued', () => {
    const r = valueGap({ currency: 'USD', libraryUnit: { amount_minor: 250000, currency: 'USD' } });
    expect(r.rung).toBe('library_unit');
    expect(r.estimated).toBe(true);
    expect(valueGap({ currency: 'USD' }).rung).toBe('unvalued');
  });
});

describe('comparable totals + renderable=false (spec 10, 10.2)', () => {
  it('gap_adjusted = base_only + valued mandatory gaps', () => {
    const gaps: GapForTotal[] = [
      { scope_node_id: 'a', strength: 'mandatory', verdict: 'absent', valuation: valueGap({ currency: 'USD', offerLine: { amount_minor: 200000, currency: 'USD' } }) },
      { scope_node_id: 'b', strength: 'mandatory', verdict: 'partial', delta_amount_minor: 50000, valuation: valueGap({ currency: 'USD' }) },
    ];
    const totals = computeTotals({ currency: 'USD', base_only_minor: 1000000, stated_minor: 1000000, gaps });
    const ga = totals.find((t) => t.total_kind === 'gap_adjusted')!;
    expect(ga.renderable).toBe(true);
    expect(ga.amount_minor).toBe(1000000 + 200000 + 50000);
    expect(ga.unvalued_gap_count).toBe(0);
  });

  it('renderable=false when any mandatory gap cannot be valued above rung 3', () => {
    const gaps: GapForTotal[] = [
      { scope_node_id: 'a', strength: 'mandatory', verdict: 'absent', valuation: valueGap({ currency: 'USD' }) }, // unvalued
    ];
    const totals = computeTotals({ currency: 'USD', base_only_minor: 1000000, stated_minor: 1000000, gaps });
    const ga = totals.find((t) => t.total_kind === 'gap_adjusted')!;
    expect(ga.renderable).toBe(false);
    expect(ga.amount_minor).toBeNull();
    expect(ga.unvalued_gap_count).toBe(1);
  });

  it('should_have gaps are reported SEPARATELY, not in gap_adjusted', () => {
    const gaps: GapForTotal[] = [
      { scope_node_id: 's', strength: 'should_have', verdict: 'absent', valuation: valueGap({ currency: 'USD', offerLine: { amount_minor: 90000, currency: 'USD' } }) },
    ];
    const totals = computeTotals({ currency: 'USD', base_only_minor: 500000, stated_minor: 500000, gaps });
    const ga = totals.find((t) => t.total_kind === 'gap_adjusted')!;
    const supp = totals.find((t) => t.total_kind === 'should_have_supplement')!;
    expect(ga.amount_minor).toBe(500000); // no mandatory gaps
    expect(supp.amount_minor).toBe(90000);
  });
});
