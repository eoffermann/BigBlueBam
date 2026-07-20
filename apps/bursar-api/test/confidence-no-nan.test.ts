import { describe, it, expect } from 'vitest';
import { compositeConfidence } from '../src/services/engines/leveling-logic.js';

// The banding score (spec 3.6) MUST be finite for every input. A NaN would silently sink a real
// gap or float a fake one, so finiteness is a hard invariant.

describe('compositeConfidence is finite for EVERY input', () => {
  const values: Array<number | null | undefined> = [
    0, 0.5, 1, -1, 2, NaN, Infinity, -Infinity, null, undefined,
  ];

  const baseline = { evidence_strength: 0.5, classifier_self_report: 0.5, node_term_overlap: 0.5, parse_quality: 0.5, window_coverage: 0.5 };
  const fields = ['evidence_strength', 'classifier_self_report', 'node_term_overlap', 'parse_quality', 'window_coverage'] as const;

  it('produces a finite [0,1] score for a degenerate value in EVERY field, for both span states', () => {
    for (const field of fields) {
      for (const v of values) {
        for (const span of [true, false]) {
          const score = compositeConfidence({ ...baseline, [field]: v, span_verified_against_line: span });
          expect(Number.isFinite(score)).toBe(true);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    }
    // Plus the all-degenerate corners, where multiple fields are pathological at once.
    for (const v of values) {
      for (const span of [true, false]) {
        const score = compositeConfidence({
          evidence_strength: v, classifier_self_report: v, node_term_overlap: v, parse_quality: v, window_coverage: v,
          span_verified_against_line: span,
        });
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rewards a fully-verified, high-evidence, complete-window input', () => {
    const strong = compositeConfidence({
      evidence_strength: 1,
      classifier_self_report: 1,
      span_verified_against_line: true,
      node_term_overlap: 1,
      parse_quality: 1,
      window_coverage: 1,
    });
    expect(strong).toBeGreaterThanOrEqual(0.85);
  });

  it('penalizes an incomplete window and a low parse quality', () => {
    const weak = compositeConfidence({
      evidence_strength: 1,
      classifier_self_report: 1,
      span_verified_against_line: true,
      node_term_overlap: 1,
      parse_quality: 0,
      window_coverage: 0,
    });
    expect(weak).toBeLessThan(1);
    expect(Number.isFinite(weak)).toBe(true);
  });
});
