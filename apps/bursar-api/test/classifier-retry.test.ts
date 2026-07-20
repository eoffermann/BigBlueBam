import { describe, it, expect } from 'vitest';
import { parseCoverageAnswers, type ClassifierLine, type ClassifierNode, type CoverageClassifier, type RawCoverageAnswer } from '../src/services/engines/leveling-classifier.js';
import { classifyBatchWithRetry } from '../src/services/engines/leveling.engine.js';
import { LlmMalformedError, LlmError, LlmThrottledError } from '../src/lib/llm-errors.js';

const LINES: ClassifierLine[] = [{ offer_line_id: 'L0', raw_text: 'Installation included' }];
function nodes(n: number): ClassifierNode[] {
  return Array.from({ length: n }, (_, i) => ({ scope_node_id: `n${i}`, title: `Node ${i}`, description: null, normative_strength: 'mandatory' }));
}

describe('parseCoverageAnswers (spec 3.4)', () => {
  it('parses a well-formed answer array keyed by scope_node_id', () => {
    const text = '[{"scope_node_id":"n0","verdict":"covered","cited_offer_line_id":"L0","quote":"Installation","classifier_confidence":0.9,"rejected_candidates":[]}]';
    const m = parseCoverageAnswers(text, 'end_turn');
    expect(m.get('n0')?.verdict).toBe('covered');
    expect(m.get('n0')?.classifier_confidence).toBe(0.9);
  });
  it('throws LlmMalformedError on finish_reason=length (truncation)', () => {
    expect(() => parseCoverageAnswers('[{"scope_node_id":"n0"', 'length')).toThrow(LlmMalformedError);
  });
  it('throws LlmMalformedError on unparseable / non-array JSON', () => {
    expect(() => parseCoverageAnswers('not json at all', null)).toThrow(LlmMalformedError);
    expect(() => parseCoverageAnswers('[{"scope_node_id":"n0",', null)).toThrow(LlmMalformedError);
  });
  it('coerces an unknown verdict to ambiguous rather than dropping the row', () => {
    const m = parseCoverageAnswers('[{"scope_node_id":"n0","verdict":"definitely_yes"}]', null);
    expect(m.get('n0')?.verdict).toBe('ambiguous');
  });
});

// A mock classifier whose behavior is scripted per call.
function mock(fn: (lines: ClassifierLine[], nodes: ClassifierNode[], call: number) => Map<string, RawCoverageAnswer>): { classifier: CoverageClassifier; calls: () => number } {
  let calls = 0;
  return {
    classifier: {
      async classifyBatch(lines, ns) {
        const out = fn(lines, ns, calls);
        calls += 1;
        return out;
      },
    },
    calls: () => calls,
  };
}
function answer(id: string, verdict: RawCoverageAnswer['verdict'] = 'covered'): RawCoverageAnswer {
  return { scope_node_id: id, verdict, cited_offer_line_id: 'L0', quote: 'Installation', classifier_confidence: 0.9, rejected_candidates: [] };
}

describe('classifyBatchWithRetry: the §3.4 failure table', () => {
  it('malformed retries at a smaller batch, capped at 2, then ambiguous (never absent)', async () => {
    const m = mock(() => {
      throw new LlmMalformedError('always truncates');
    });
    const result = await classifyBatchWithRetry(m.classifier, LINES, nodes(4), { malformedBudget: 2 });
    // Every node falls back to ambiguous.
    for (let i = 0; i < 4; i++) expect(result.get(`n${i}`)?.verdict).toBe('ambiguous');
    for (const a of result.values()) expect(a.verdict).not.toBe('absent');
    // The retry recursion is bounded (budget 2 halving), not unbounded.
    expect(m.calls()).toBeLessThanOrEqual(8);
  });

  it('a node MISSING from the batch response is retried individually, then ambiguous, never absent', async () => {
    const m = mock((_l, ns, call) => {
      const out = new Map<string, RawCoverageAnswer>();
      if (call === 0) {
        // First batch omits n1.
        for (const n of ns) if (n.scope_node_id !== 'n1') out.set(n.scope_node_id, answer(n.scope_node_id));
      }
      // The individual retry for n1 also returns nothing.
      return out;
    });
    const result = await classifyBatchWithRetry(m.classifier, LINES, nodes(3));
    expect(result.get('n0')?.verdict).toBe('covered');
    expect(result.get('n2')?.verdict).toBe('covered');
    expect(result.get('n1')?.verdict).toBe('ambiguous'); // retried individually, then ambiguous
    expect(result.get('n1')?.verdict).not.toBe('absent');
  });

  it('LlmError yields ambiguous for the whole batch, never absent', async () => {
    const m = mock(() => {
      throw new LlmError('proxy 502', 502);
    });
    const result = await classifyBatchWithRetry(m.classifier, LINES, nodes(3));
    for (let i = 0; i < 3; i++) expect(result.get(`n${i}`)?.verdict).toBe('ambiguous');
  });

  it('LlmThrottledError re-throws so the slice can DEFER (never a default verdict)', async () => {
    const m = mock(() => {
      throw new LlmThrottledError(2);
    });
    await expect(classifyBatchWithRetry(m.classifier, LINES, nodes(3))).rejects.toBeInstanceOf(LlmThrottledError);
  });
});
