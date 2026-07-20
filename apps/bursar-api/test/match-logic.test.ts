import { describe, it, expect } from 'vitest';
import { segmentLines } from '../src/services/engines/parse-logic.js';
import {
  computePerOfferCounters,
  evaluateCaps,
  lineMatchesNode,
  matchLinesToNodes,
  significantTokens,
  type ScopeNodeRef,
} from '../src/services/engines/match-logic.js';

// Deterministic structural matching + the two per-offer counters (spec 4.3), NO LLM.

describe('significantTokens / lineMatchesNode', () => {
  it('drops stopwords and short tokens, then matches by subset containment', () => {
    expect(significantTokens('On-site training')).toEqual(['site', 'training']);
    expect(lineMatchesNode('on-site operator training session', ['site', 'training'])).toBe(true);
    expect(lineMatchesNode('operator training session', ['site', 'training'])).toBe(false);
  });

  it('a node with no significant tokens never matches', () => {
    expect(lineMatchesNode('anything at all', [])).toBe(false);
  });
});

describe('matchLinesToNodes (spec 4.4: only base lines count)', () => {
  const nodes: ScopeNodeRef[] = [
    { id: 'n1', title: 'Installation', normative_strength: 'mandatory' },
    { id: 'n2', title: 'Warranty', normative_strength: 'mandatory' },
  ];

  it('matches a base line and IGNORES an option line', () => {
    const lines = segmentLines('Installation and warranty bundle. $10,000\nOption: extended warranty. $2,000');
    const matches = matchLinesToNodes(lines, nodes);
    // base line matches both nodes; the option line matches none (it is not a base line).
    expect(matches.filter((m) => m.offer_line_ordinal === 0)).toHaveLength(2);
    expect(matches.filter((m) => m.offer_line_ordinal === 1)).toHaveLength(0);
  });
});

describe('computePerOfferCounters + evaluateCaps (spec 4.3)', () => {
  it('counts distinct unsub-priced mandatory nodes and the concentration ratio, PER OFFER', () => {
    const nodes: ScopeNodeRef[] = [
      { id: 'n1', title: 'A', normative_strength: 'mandatory' },
      { id: 'n2', title: 'B', normative_strength: 'mandatory' },
      { id: 'n3', title: 'C', normative_strength: 'should_have' },
    ];
    const matches = [
      { offer_line_ordinal: 0, scope_node_id: 'n1', match_method: 'structural' as const, subpriced: false },
      { offer_line_ordinal: 0, scope_node_id: 'n2', match_method: 'structural' as const, subpriced: false },
      { offer_line_ordinal: 0, scope_node_id: 'n3', match_method: 'structural' as const, subpriced: false },
    ];
    const counters = computePerOfferCounters(matches, nodes);
    // n3 is should_have, not mandatory, so it does not count.
    expect(counters.unsubpriced_mandatory_count).toBe(2);
    // 1 distinct line / 2 covered mandatory nodes = 0.5.
    expect(counters.evidence_concentration).toBeCloseTo(0.5, 5);
  });

  it('null concentration when no mandatory node is covered', () => {
    const nodes: ScopeNodeRef[] = [{ id: 'n1', title: 'A', normative_strength: 'should_have' }];
    const counters = computePerOfferCounters([], nodes);
    expect(counters.unsubpriced_mandatory_count).toBe(0);
    expect(counters.evidence_concentration).toBeNull();
  });

  it('trips both caps when the offer fans 14 nodes over 4 lines', () => {
    const nodes: ScopeNodeRef[] = Array.from({ length: 14 }, (_, i) => ({
      id: `n${i}`,
      title: `T${i}`,
      normative_strength: 'mandatory',
    }));
    const matches = nodes.map((n, i) => ({
      offer_line_ordinal: i % 4,
      scope_node_id: n.id,
      match_method: 'structural' as const,
      subpriced: false,
    }));
    const counters = computePerOfferCounters(matches, nodes);
    expect(counters.unsubpriced_mandatory_count).toBe(14);
    const caps = evaluateCaps(counters, matches, {
      blanket_cumulative_cap: 4,
      evidence_concentration_floor: 0.5,
      blanket_fanout_cap: 4,
    });
    expect(caps.tripped).toBe(true);
    expect(caps.reasons).toContain('cumulative_cap');
    expect(caps.reasons).toContain('evidence_concentration');
  });
});
