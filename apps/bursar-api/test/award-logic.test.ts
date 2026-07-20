import { describe, it, expect } from 'vitest';
import {
  amendAwardChain,
  baselineHash,
  baselineKindCounts,
  classifyBaselineKind,
  composeBaseline,
  freshAwardChain,
  latestActivePerOrdinal,
  type BaselineCoverageInput,
  type BaselineLineInput,
  type BaselineNodeInput,
  type ChainItemRef,
} from '../src/services/award-logic.js';

// Pure award-service logic (spec 7, M7). No DB. This is the M5 pattern: the deterministic
// freeze decisions are unit-tested with plain inputs; awards.service.ts persists them.

describe('classifyBaselineKind', () => {
  it('maps every verdict to one of the three frozen kinds', () => {
    expect(classifyBaselineKind('covered')).toBe('included');
    expect(classifyBaselineKind('partial')).toBe('included');
    expect(classifyBaselineKind('excluded_explicit')).toBe('excluded_at_award');
    expect(classifyBaselineKind('not_applicable')).toBe('excluded_at_award');
    expect(classifyBaselineKind('absent')).toBe('absent_at_award');
    expect(classifyBaselineKind('ambiguous')).toBe('absent_at_award');
    // A missing coverage row is absent_at_award, never dropped.
    expect(classifyBaselineKind(null)).toBe('absent_at_award');
    expect(classifyBaselineKind(undefined)).toBe('absent_at_award');
  });
});

describe('composeBaseline (spec 7.1 freeze)', () => {
  const nodes: BaselineNodeInput[] = [
    { id: 'n-install', ordinal: 0, title: 'Installation', unit: 'ea', quantity: '1' },
    { id: 'n-warranty', ordinal: 1, title: 'Warranty', unit: 'yr', quantity: '3' },
    { id: 'n-training', ordinal: 2, title: 'Crew training', unit: 'session', quantity: '2' },
    { id: 'n-escalation', ordinal: 3, title: 'Escalation cap' },
  ];
  const lines: BaselineLineInput[] = [
    { id: 'l-install', unit: 'ea', quantity: '1', unit_price_minor: 500000, extended_minor: 500000, currency: 'USD' },
    { id: 'l-warranty', unit: 'yr', quantity: '1', unit_price_minor: 0, extended_minor: 0, currency: 'USD' },
  ];
  const coverage: BaselineCoverageInput[] = [
    { scope_node_id: 'n-install', verdict: 'covered', matched_line_ids: ['l-install'] },
    // Warranty is a partial with a term reduction (3yr requested, 1yr offered) -> delta_kind='term'.
    { scope_node_id: 'n-warranty', verdict: 'partial', matched_line_ids: ['l-warranty'], delta_kind: 'term', delta_amount_minor: 12000 },
    { scope_node_id: 'n-training', verdict: 'excluded_explicit', matched_line_ids: [] },
    // n-escalation has NO coverage row at all.
  ];

  it('produces exactly one baseline item per node, in ordinal order', () => {
    const items = composeBaseline({ nodes, coverage, lines, currency: 'USD' });
    expect(items).toHaveLength(nodes.length);
    expect(items.map((i) => i.title)).toEqual(['Installation', 'Warranty', 'Crew training', 'Escalation cap']);
    // Each item links back to exactly its node.
    expect(items.map((i) => i.node_ids)).toEqual([['n-install'], ['n-warranty'], ['n-training'], ['n-escalation']]);
  });

  it('the structural invariant: included + excluded_at_award + absent_at_award == node count', () => {
    const items = composeBaseline({ nodes, coverage, lines, currency: 'USD' });
    const counts = baselineKindCounts(items);
    expect(counts.included).toBe(2); // install + warranty
    expect(counts.excluded_at_award).toBe(1); // training
    expect(counts.absent_at_award).toBe(1); // escalation (no coverage row)
    expect(counts.included + counts.excluded_at_award + counts.absent_at_award).toBe(nodes.length);
    expect(counts.total).toBe(nodes.length);
  });

  it('the warranty node is included with delta_kind=term (the Playwright step 9 assertion)', () => {
    const items = composeBaseline({ nodes, coverage, lines, currency: 'USD' });
    const warranty = items.find((i) => i.title === 'Warranty')!;
    expect(warranty.kind).toBe('included');
    expect(warranty.delta_kind).toBe('term');
    expect(warranty.delta_amount_minor).toBe(12000);
    expect(warranty.coverage_verdict_at_award).toBe('partial');
  });

  it('included items inherit price from the matched line; excluded/absent carry no price', () => {
    const items = composeBaseline({ nodes, coverage, lines, currency: 'USD' });
    const install = items.find((i) => i.title === 'Installation')!;
    expect(install.unit_price_minor).toBe(500000);
    expect(install.source_offer_line_id).toBe('l-install');
    const training = items.find((i) => i.title === 'Crew training')!;
    expect(training.kind).toBe('excluded_at_award');
    expect(training.unit_price_minor).toBeNull();
    const escalation = items.find((i) => i.title === 'Escalation cap')!;
    expect(escalation.kind).toBe('absent_at_award');
    expect(escalation.coverage_verdict_at_award).toBe('absent');
    expect(escalation.currency).toBe('USD');
  });
});

describe('baselineHash determinism', () => {
  const nodes: BaselineNodeInput[] = [
    { id: 'n1', ordinal: 0, title: 'A' },
    { id: 'n2', ordinal: 1, title: 'B' },
  ];
  const coverage: BaselineCoverageInput[] = [
    { scope_node_id: 'n1', verdict: 'covered', matched_line_ids: [] },
    { scope_node_id: 'n2', verdict: 'absent', matched_line_ids: [] },
  ];
  const ctx = { request_id: 'r1', offer_id: 'o1', currency: 'USD', term_start: '2026-01-01', term_end: null };

  it('is stable for the same content', () => {
    const a = baselineHash(composeBaseline({ nodes, coverage, lines: [], currency: 'USD' }), ctx);
    const b = baselineHash(composeBaseline({ nodes, coverage, lines: [], currency: 'USD' }), ctx);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is invariant to input item order (items are sorted before hashing)', () => {
    const items = composeBaseline({ nodes, coverage, lines: [], currency: 'USD' });
    const reversed = [...items].reverse();
    expect(baselineHash(items, ctx)).toBe(baselineHash(reversed, ctx));
  });

  it('changes when any frozen content changes', () => {
    const base = baselineHash(composeBaseline({ nodes, coverage, lines: [], currency: 'USD' }), ctx);
    // Different term window -> different frozen record.
    const diffTerm = baselineHash(composeBaseline({ nodes, coverage, lines: [], currency: 'USD' }), { ...ctx, term_end: '2027-01-01' });
    expect(diffTerm).not.toBe(base);
    // Different verdict -> different item -> different hash.
    const flipped = baselineHash(
      composeBaseline({
        nodes,
        coverage: [coverage[0]!, { scope_node_id: 'n2', verdict: 'covered', matched_line_ids: [] }],
        lines: [],
        currency: 'USD',
      }),
      ctx,
    );
    expect(flipped).not.toBe(base);
  });
});

describe('the award chain (spec 7.2)', () => {
  it('a fresh award is its own chain root with no predecessor', () => {
    const chain = freshAwardChain('a1');
    expect(chain.id).toBe('a1');
    expect(chain.chain_root_id).toBe('a1');
    expect(chain.supersedes_award_id).toBeNull();
  });

  it('an amendment inherits chain_root and points at its predecessor', () => {
    const predecessor = { id: 'a1', chain_root_id: 'a1' };
    const chain = amendAwardChain('a2', predecessor);
    expect(chain.id).toBe('a2');
    expect(chain.chain_root_id).toBe('a1');
    expect(chain.supersedes_award_id).toBe('a1');
    // A third amendment keeps the SAME root (the chain does not re-root).
    const third = amendAwardChain('a3', { id: 'a2', chain_root_id: chain.chain_root_id });
    expect(third.chain_root_id).toBe('a1');
    expect(third.supersedes_award_id).toBe('a2');
  });

  it('drift resolves the latest ACTIVE item per (chain_root_id, ordinal)', () => {
    const items: ChainItemRef[] = [
      { chain_root_id: 'a1', ordinal: 0, award_status: 'superseded', award_sequence: 1, value: 'v0-old' },
      { chain_root_id: 'a1', ordinal: 0, award_status: 'active', award_sequence: 2, value: 'v0-new' },
      { chain_root_id: 'a1', ordinal: 1, award_status: 'active', award_sequence: 2, value: 'v1' },
      // A terminated item never resolves, even at a higher sequence.
      { chain_root_id: 'a1', ordinal: 1, award_status: 'terminated', award_sequence: 3, value: 'v1-dead' },
    ];
    const resolved = latestActivePerOrdinal(items);
    const values = resolved.map((r) => r.value).sort();
    expect(values).toEqual(['v0-new', 'v1']);
  });
});
