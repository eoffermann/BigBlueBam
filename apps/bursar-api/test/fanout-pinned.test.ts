import { describe, it, expect } from 'vitest';
import {
  effectiveFanoutMatches,
  maxLineFanout,
  evaluateCumulativeCaps,
  type FanoutMatch,
} from '../src/services/engines/leveling-logic.js';

// The pinning exemption is SCOPED to the verdict it exists for (spec 3.8): a pinned (exclusion-hit)
// line's matches count toward fan-out UNLESS the resulting verdict is excluded_explicit. A blanket
// line dressed as an exclusion ("Nothing is excluded: installation, training and warranty are all
// provided") gets pinned but produces `covered`, so it STILL counts and cannot escape the defense.

const THRESHOLDS = { blanket_cumulative_cap: 4, evidence_concentration_floor: 0.5, blanket_fanout_cap: 4 };

describe('exclusion pinning: fan-out exemption scoped to excluded_explicit', () => {
  it('a pinned line producing excluded_explicit is EXEMPT from the fan-out count', () => {
    const matches: FanoutMatch[] = [
      { offer_line_id: 'X', scope_node_id: 'n0', verdict: 'excluded_explicit', pinned: true },
      { offer_line_id: 'X', scope_node_id: 'n1', verdict: 'excluded_explicit', pinned: true },
      { offer_line_id: 'X', scope_node_id: 'n2', verdict: 'excluded_explicit', pinned: true },
    ];
    expect(effectiveFanoutMatches(matches)).toHaveLength(0);
    expect(maxLineFanout(matches)).toBe(0);
  });
  it('a pinned line producing COVERED still counts toward fan-out (the blanket-in-exclusion-clothing case)', () => {
    const matches: FanoutMatch[] = [
      { offer_line_id: 'Y', scope_node_id: 'n0', verdict: 'covered', pinned: true },
      { offer_line_id: 'Y', scope_node_id: 'n1', verdict: 'covered', pinned: true },
      { offer_line_id: 'Y', scope_node_id: 'n2', verdict: 'covered', pinned: true },
    ];
    expect(effectiveFanoutMatches(matches)).toHaveLength(3);
    expect(maxLineFanout(matches)).toBe(3);
  });
});

describe('Defense 2: cumulative per-offer caps trip on the split attack', () => {
  it('the split-blanket (12 covered mandatory over 4 lines) trips BOTH cumulative guards', () => {
    const covered = new Set(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11']);
    const verdict = evaluateCumulativeCaps(
      {
        coveredMandatoryNodeIds: covered,
        subpricedMandatoryNodeIds: new Set(), // none sub-priced (the attack)
        distinctCitedLines: 4,
        fanoutMatches: [],
      },
      THRESHOLDS,
    );
    expect(verdict.tripped).toBe(true);
    expect(verdict.unsubpriced_mandatory_count).toBe(12);
    expect(verdict.reasons).toContain('cumulative_cap'); // 12 > 4
    expect(verdict.evidence_concentration).toBeCloseTo(4 / 12, 4);
    expect(verdict.reasons).toContain('evidence_concentration'); // 0.33 < 0.5
    expect(verdict.withheldReason).toBe('blanket_cap');
  });
  it('a legitimately sub-priced bundle (all subpriced) does NOT trip the cumulative cap', () => {
    const covered = new Set(['n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
    const verdict = evaluateCumulativeCaps(
      {
        coveredMandatoryNodeIds: covered,
        subpricedMandatoryNodeIds: covered, // every one explicitly sub-priced
        distinctCitedLines: 6,
        fanoutMatches: [],
      },
      THRESHOLDS,
    );
    expect(verdict.unsubpriced_mandatory_count).toBe(0);
    expect(verdict.tripped).toBe(false);
    expect(verdict.evidence_concentration).toBe(1);
  });
  it('per-line fan-out is retained as a cheap early signal (>cap)', () => {
    const covered = new Set(['a']);
    const fan: FanoutMatch[] = [0, 1, 2, 3, 4].map((i) => ({ offer_line_id: 'L', scope_node_id: `n${i}`, verdict: 'covered', pinned: false }));
    const verdict = evaluateCumulativeCaps(
      { coveredMandatoryNodeIds: covered, subpricedMandatoryNodeIds: covered, distinctCitedLines: 1, fanoutMatches: fan },
      THRESHOLDS,
    );
    expect(verdict.reasons).toContain('per_line_fanout'); // 5 > 4
  });
});
