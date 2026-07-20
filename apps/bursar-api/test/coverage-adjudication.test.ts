import { describe, it, expect } from 'vitest';
import { adjudicateOffer, type AdjudicationAnswer } from '../src/services/engines/coverage-adjudication.js';
import { buildWindows, type EngineLine } from '../src/services/engines/leveling.engine.js';
import {
  SETTINGS,
  singleBlanket,
  splitBlanket,
  legitimateSubprice,
  injectionSuspected,
  tree,
  offer,
} from './fixtures/coverage-collapse.js';

function autoPublishedCovered(result: ReturnType<typeof adjudicateOffer>): number {
  return result.decisions.filter((d) => d.decision.verdict === 'covered' && d.decision.autoPublished).length;
}

// The §4.7 diff-completeness invariant, asserted PER FIXTURE (spec 20.2). This is the CI gate: a
// defense that converts a false covered into a SILENT OMISSION would let the attacker win anyway.
function assertDiffComplete(result: ReturnType<typeof adjudicateOffer>, mandatoryCount: number) {
  const { published, needs_review, unverified, total, complete } = result.diff;
  expect(published.length + needs_review.length + unverified.length).toBe(mandatoryCount);
  expect(total).toBe(mandatoryCount);
  expect(complete).toBe(true);
}

describe('§4 corpus gates: coverage-collapse fixtures replayed through adjudicateOffer', () => {
  it('single-blanket: ZERO auto-published covered; 14-node tree not fully covered; diff complete', () => {
    const fx = singleBlanket();
    const result = adjudicateOffer(fx.offer, fx.nodes, fx.lines, fx.answers, SETTINGS, true);
    expect(autoPublishedCovered(result)).toBe(0);
    assertDiffComplete(result, 14);
    // Not fully covered: at least one mandatory node is not a published covered.
    expect(result.diff.published.length).toBeLessThan(14);
  });

  it('split-blanket (4 lines x 3 nodes, no lexicon): ZERO auto-published; cumulative caps TRIP; diff complete', () => {
    const fx = splitBlanket();
    const result = adjudicateOffer(fx.offer, fx.nodes, fx.lines, fx.answers, SETTINGS, true);
    expect(autoPublishedCovered(result)).toBe(0);
    expect(result.caps.tripped).toBe(true);
    expect(result.caps.reasons).toContain('cumulative_cap');
    expect(result.unsubpriced_mandatory_count).toBeGreaterThan(SETTINGS.blanket_cumulative_cap);
    assertDiffComplete(result, 12);
    // The withheld reason is persisted so the diff renders the row explicitly, never drops it.
    const withheld = result.decisions.filter((d) => d.decision.withheldReason === 'blanket_cap');
    expect(withheld.length).toBeGreaterThan(0);
  });

  it('legitimate sub-priced bundle: DOES auto-publish covered (the false-positive guard)', () => {
    const fx = legitimateSubprice();
    const result = adjudicateOffer(fx.offer, fx.nodes, fx.lines, fx.answers, SETTINGS, true);
    expect(autoPublishedCovered(result)).toBe(6);
    expect(result.caps.tripped).toBe(false);
    assertDiffComplete(result, 6);
  });

  it('injection-suspected: ZERO auto-published covered despite good evidence; diff complete', () => {
    const fx = injectionSuspected();
    const result = adjudicateOffer(fx.offer, fx.nodes, fx.lines, fx.answers, SETTINGS, true);
    expect(autoPublishedCovered(result)).toBe(0);
    assertDiffComplete(result, 6);
  });
});

describe('blanket_suspected does NOT suppress absent (spec 3.6)', () => {
  it('publishes a mandatory absent on a blanket-suspected offer that parsed cleanly', () => {
    const nodes = tree(1); // one mandatory node
    const lines: EngineLine[] = [
      { offer_line_id: 'L0', ordinal: 0, raw_text: 'We provide a comprehensive turnkey solution', line_role: 'base', blanket_claim: true, exclusion_hit: false, extended_minor: 100000 },
    ];
    const answers = new Map<string, AdjudicationAnswer>([
      ['n0', { scope_node_id: 'n0', verdict: 'absent', cited_offer_line_id: null, quote: null, classifier_confidence: 0.8, rejected_candidates: [{ offer_line_id: 'L0', reason: 'names no installation' }] }],
    ]);
    const result = adjudicateOffer(
      offer({ blanket_suspected: true, parse_quality: 0.9 }),
      nodes,
      lines,
      answers,
      SETTINGS,
      true,
    );
    const d = result.decisions.find((x) => x.scope_node_id === 'n0')!;
    expect(d.decision.verdict).toBe('absent');
    expect(d.decision.autoPublished).toBe(true); // a blanket claim is evidence FOR absence, not against it
  });
});

describe('long-document terminal exclusion (spec 3.8)', () => {
  it('pins an exclusion line into every window regardless of boundary', () => {
    const lines: EngineLine[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push({ offer_line_id: `L${i}`, ordinal: i, raw_text: `Priced item ${i}`, line_role: 'base', blanket_claim: false, exclusion_hit: false, extended_minor: 1000 });
    }
    // A terminal exclusions block far from the priced lines.
    lines.push({ offer_line_id: 'EX', ordinal: 30, raw_text: 'Installation is by others and explicitly excluded', line_role: 'note', blanket_claim: false, exclusion_hit: true, extended_minor: null });
    const windows = buildWindows(lines, 10, 2);
    expect(windows.length).toBeGreaterThan(1);
    // The pinned exclusion line appears in EVERY window.
    for (const w of windows) {
      expect(w.lines.some((l) => l.offer_line_id === 'EX')).toBe(true);
    }
  });

  it('an excluded_explicit verdict citing the exclusion line publishes as a gap', () => {
    const nodes = tree(1);
    const lines: EngineLine[] = [
      { offer_line_id: 'EX', ordinal: 0, raw_text: 'Site installation is by others and explicitly excluded', line_role: 'note', blanket_claim: false, exclusion_hit: true, extended_minor: null },
    ];
    const answers = new Map<string, AdjudicationAnswer>([
      ['n0', { scope_node_id: 'n0', verdict: 'excluded_explicit', cited_offer_line_id: 'EX', quote: 'Site installation is by others', classifier_confidence: 0.95, rejected_candidates: [] }],
    ]);
    const result = adjudicateOffer(offer(), nodes, lines, answers, SETTINGS, true);
    const d = result.decisions[0]!;
    expect(d.decision.verdict).toBe('excluded_explicit');
    expect(d.decision.autoPublished).toBe(true);
    expect(d.decision.isGap).toBe(true);
  });
});

describe('Defense 3: downward subsumption + de-transitivized upward rollup', () => {
  it('a covered bundling parent promotes an absent child to derived_covered (verdict-preserving)', () => {
    const nodes = [
      { scope_node_id: 'p', parent_id: null, title: 'System package', description: null, normative_strength: 'mandatory' as const },
      { scope_node_id: 'c', parent_id: 'p', title: 'Data export', description: null, normative_strength: 'mandatory' as const },
    ];
    const lines: EngineLine[] = [
      { offer_line_id: 'L0', ordinal: 0, raw_text: 'System package including data export $5,000', line_role: 'base', blanket_claim: false, exclusion_hit: false, extended_minor: 500000 },
    ];
    const answers = new Map<string, AdjudicationAnswer>([
      ['p', { scope_node_id: 'p', verdict: 'covered', cited_offer_line_id: 'L0', quote: 'System package including data export', classifier_confidence: 0.95, rejected_candidates: [], allocation_method: 'explicit_subprice', priced_amount_minor: 500000 }],
      ['c', { scope_node_id: 'c', verdict: 'absent', cited_offer_line_id: null, quote: null, classifier_confidence: 0.5, rejected_candidates: [{ offer_line_id: 'L0' }] }],
    ]);
    const result = adjudicateOffer(offer(), nodes, lines, answers, SETTINGS, true);
    const child = result.decisions.find((d) => d.scope_node_id === 'c')!;
    expect(child.derived_covered).toBe(true);
    expect(child.decision.isGap).toBe(false);
  });

  it('an excluded_explicit child is NEVER overwritten by a covered parent', () => {
    const nodes = [
      { scope_node_id: 'p', parent_id: null, title: 'System package', description: null, normative_strength: 'mandatory' as const },
      { scope_node_id: 'c', parent_id: 'p', title: 'Crew training', description: null, normative_strength: 'mandatory' as const },
    ];
    const lines: EngineLine[] = [
      { offer_line_id: 'L0', ordinal: 0, raw_text: 'System package $5,000', line_role: 'base', blanket_claim: false, exclusion_hit: false, extended_minor: 500000 },
      { offer_line_id: 'EX', ordinal: 1, raw_text: 'Crew training is excluded and by others', line_role: 'note', blanket_claim: false, exclusion_hit: true, extended_minor: null },
    ];
    const answers = new Map<string, AdjudicationAnswer>([
      ['p', { scope_node_id: 'p', verdict: 'covered', cited_offer_line_id: 'L0', quote: 'System package', classifier_confidence: 0.95, rejected_candidates: [], allocation_method: 'explicit_subprice', priced_amount_minor: 500000 }],
      ['c', { scope_node_id: 'c', verdict: 'excluded_explicit', cited_offer_line_id: 'EX', quote: 'Crew training is excluded', classifier_confidence: 0.95, rejected_candidates: [] }],
    ]);
    const result = adjudicateOffer(offer(), nodes, lines, answers, SETTINGS, true);
    const child = result.decisions.find((d) => d.scope_node_id === 'c')!;
    expect(child.derived_covered).toBe(false);
    expect(child.decision.verdict).toBe('excluded_explicit'); // preserved
    expect(child.decision.isGap).toBe(true);
  });
});
