import { describe, it, expect } from 'vitest';
import {
  classifyCoverage,
  type ClassifyContext,
  type ClassifyPredicates,
  type Verdict,
} from '../src/services/engines/leveling-logic.js';

const PASS: ClassifyPredicates = { spanVerified: true, overlap: 0.9, overlapFloor: 0.25, rejectedValid: true };

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    strength: 'mandatory',
    score: 0.95,
    windowComplete: true,
    capTripped: false,
    capWithheldReason: null,
    blanketClaimLine: false,
    suspected: false,
    parseCleanForAbsent: true,
    humanConfirmed: false,
    bundlingNodeCount: 1,
    allocationMethod: null,
    ...over,
  };
}

describe('classifyCoverage: covered auto-publish gates (Defenses 1/2/3 + suspicion + band)', () => {
  it('auto-publishes a clean high-band covered', () => {
    const d = classifyCoverage('covered', PASS, ctx());
    expect(d.verdict).toBe('covered');
    expect(d.band).toBe('high');
    expect(d.autoPublished).toBe(true);
    expect(d.reviewStatus).toBe('published');
  });
  it('Defense 1: a blanket-claim line cannot auto-publish covered', () => {
    const d = classifyCoverage('covered', PASS, ctx({ blanketClaimLine: true }));
    expect(d.autoPublished).toBe(false);
    expect(d.withheldReason).toBe('blanket_cap');
  });
  it('spec 3.6: a suspected offer cannot auto-publish covered', () => {
    const d = classifyCoverage('covered', PASS, ctx({ suspected: true }));
    expect(d.autoPublished).toBe(false);
  });
  it('Defense 2: a tripped cumulative cap withholds covered with its reason', () => {
    const d = classifyCoverage('covered', PASS, ctx({ capTripped: true, capWithheldReason: 'concentration' }));
    expect(d.autoPublished).toBe(false);
    expect(d.withheldReason).toBe('concentration');
  });
  it('Defense 3: a bundling line (>1 node) auto-publishes covered ONLY at explicit_subprice', () => {
    expect(classifyCoverage('covered', PASS, ctx({ bundlingNodeCount: 3, allocationMethod: 'equal_split' })).autoPublished).toBe(false);
    expect(classifyCoverage('covered', PASS, ctx({ bundlingNodeCount: 3, allocationMethod: 'explicit_subprice' })).autoPublished).toBe(true);
  });
  it('predicate failure demotes covered to ambiguous (never published)', () => {
    expect(classifyCoverage('covered', { ...PASS, spanVerified: false }, ctx()).verdict).toBe('ambiguous');
    expect(classifyCoverage('covered', { ...PASS, overlap: 0.1 }, ctx()).verdict).toBe('ambiguous');
    expect(classifyCoverage('covered', { ...PASS, spanVerified: false }, ctx()).autoPublished).toBe(false);
  });
  it('a medium band never auto-publishes covered and is excluded from headline', () => {
    const d = classifyCoverage('covered', PASS, ctx({ score: 0.7 }));
    expect(d.band).toBe('medium');
    expect(d.autoPublished).toBe(false);
    expect(d.withheldReason).toBe('band');
  });
});

describe('classifyCoverage: the asymmetric mandatory-absent rule (spec 3.6)', () => {
  const absentPred: ClassifyPredicates = { spanVerified: false, overlap: 0, overlapFloor: 0.25, rejectedValid: true };
  it('publishes a mandatory absent when the offer parsed cleanly with complete windows', () => {
    const d = classifyCoverage('absent', absentPred, ctx({ parseCleanForAbsent: true }));
    expect(d.verdict).toBe('absent');
    expect(d.autoPublished).toBe(true);
    expect(d.isGap).toBe(true);
  });
  it('does NOT publish a mandatory absent when the offer did not parse cleanly', () => {
    const d = classifyCoverage('absent', absentPred, ctx({ parseCleanForAbsent: false }));
    expect(d.autoPublished).toBe(false);
    expect(d.withheldReason).toBe('unparseable');
  });
  it('a human-confirmed absent publishes even without a clean parse', () => {
    const d = classifyCoverage('absent', absentPred, ctx({ parseCleanForAbsent: false, humanConfirmed: true }));
    expect(d.autoPublished).toBe(true);
  });
  it('suspicion flags do NOT gate absent (writing "turnkey" once does not buy immunity)', () => {
    const d = classifyCoverage('absent', absentPred, ctx({ suspected: true, parseCleanForAbsent: true }));
    expect(d.verdict).toBe('absent');
    expect(d.autoPublished).toBe(true);
  });
  it('an absent with an invalid rejected set demotes to ambiguous (predicate 2)', () => {
    const d = classifyCoverage('absent', { ...absentPred, rejectedValid: false }, ctx());
    expect(d.verdict).toBe('ambiguous');
    expect(d.autoPublished).toBe(false);
  });
});

describe('classifyCoverage: exclusion, partial, ambiguous, not_applicable', () => {
  it('excluded_explicit publishes on a high band and IS a gap; suspicion does not block it', () => {
    const d = classifyCoverage('excluded_explicit', PASS, ctx({ suspected: true }));
    expect(d.verdict).toBe('excluded_explicit');
    expect(d.autoPublished).toBe(true);
    expect(d.isGap).toBe(true);
  });
  it('partial publishes on a high band and IS a gap', () => {
    const d = classifyCoverage('partial', PASS, ctx());
    expect(d.autoPublished).toBe(true);
    expect(d.isGap).toBe(true);
  });
  it('ambiguous is never published; low band', () => {
    const d = classifyCoverage('ambiguous', PASS, ctx());
    expect(d.autoPublished).toBe(false);
    expect(d.band).toBe('low');
  });
  it('not_applicable is a cleared, non-gap verdict', () => {
    const d = classifyCoverage('not_applicable', PASS, ctx());
    expect(d.isGap).toBe(false);
    expect(d.reviewStatus).toBe('published');
  });
});

describe('classifyCoverage: the full decision table never throws and is well-formed', () => {
  const verdicts: Verdict[] = ['covered', 'partial', 'excluded_explicit', 'absent', 'ambiguous', 'not_applicable'];
  const strengths: ClassifyContext['strength'][] = ['mandatory', 'should_have', 'nice_to_have', 'informational'];
  const predSets: ClassifyPredicates[] = [
    PASS,
    { ...PASS, spanVerified: false },
    { ...PASS, overlap: 0.1 },
    { ...PASS, rejectedValid: false },
  ];
  it('six verdicts x four predicate sets x four strengths all yield a valid decision', () => {
    let count = 0;
    for (const v of verdicts) {
      for (const p of predSets) {
        for (const s of strengths) {
          const d = classifyCoverage(v, p, ctx({ strength: s }));
          expect(['high', 'medium', 'low']).toContain(d.band);
          expect(['published', 'needs_review', 'unverified']).toContain(d.reviewStatus);
          if (d.autoPublished) expect(d.reviewStatus).toBe('published');
          count += 1;
        }
      }
    }
    expect(count).toBe(6 * 4 * 4);
  });
});
