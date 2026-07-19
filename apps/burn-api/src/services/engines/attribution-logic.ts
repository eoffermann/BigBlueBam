/**
 * Pure attribution decision helpers (spec 4.2 / 9.7.1), split out with NO db/env/llm-client import
 * so the §12.1 unit suite can exercise them directly. attribution.engine.ts re-exports these.
 */

export type AttributionOutcome =
  | 'attributed'
  | 'pending_review'
  | 'pending_attribution'
  | 'unscoped'
  | 'excluded_non_billable';

/**
 * Map an LLM failure to the correct deferral (spec 9.7.1 / §12.1). A 429 (concurrency cap or daily
 * cap) defers to `pending_attribution` so throttling can NEVER manufacture a scope-creep `unscoped`
 * finding; any other failure yields `pending_review`. Checked by error NAME (not instanceof) so this
 * module stays free of the llm-client import (which pulls env).
 */
export function classifyLlmFailure(err: unknown): 'pending_attribution' | 'pending_review' {
  if (err instanceof Error && err.name === 'LlmThrottledError') return 'pending_attribution';
  return 'pending_review';
}

export interface AdjudicationResult {
  deliverable_id: string | null;
  confidence: number;
  outcome: AttributionOutcome;
  unscoped_reason: string | null;
}

/**
 * Interpret a stage-two model response against the BOUNDED candidate set (spec 2.3.5 / §12.1). A
 * model naming an id OUTSIDE the candidate set drops to `pending_review`; an injection string
 * cannot change the target because only a member of `candidateIds` is ever accepted.
 */
export function interpretAdjudication(
  modelText: string,
  candidateIds: string[],
  autoThreshold: number,
  reviewThreshold: number,
): AdjudicationResult {
  let parsed: { deliverable_id?: unknown; confidence?: unknown } = {};
  try {
    const jsonStart = modelText.indexOf('{');
    const jsonEnd = modelText.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      parsed = JSON.parse(modelText.slice(jsonStart, jsonEnd + 1));
    }
  } catch {
    return { deliverable_id: null, confidence: 0, outcome: 'pending_review', unscoped_reason: null };
  }
  const named = typeof parsed.deliverable_id === 'string' ? parsed.deliverable_id : null;
  const conf =
    typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : 0;

  if (!named || !candidateIds.includes(named)) {
    return { deliverable_id: null, confidence: conf, outcome: 'pending_review', unscoped_reason: null };
  }
  if (conf >= autoThreshold) {
    return { deliverable_id: named, confidence: conf, outcome: 'attributed', unscoped_reason: null };
  }
  if (conf >= reviewThreshold) {
    return { deliverable_id: named, confidence: conf, outcome: 'pending_review', unscoped_reason: null };
  }
  return { deliverable_id: null, confidence: conf, outcome: 'unscoped', unscoped_reason: 'low_confidence' };
}

/** Coarse band for an amount (spec 2.4 point 13 - events carry a band, never the amount). */
export function bandFor(amountMinor: number): string {
  const dollars = amountMinor / 100;
  if (dollars < 500) return 'under_500';
  if (dollars < 2000) return '500_2k';
  if (dollars < 10000) return '2k_10k';
  if (dollars < 50000) return '10k_50k';
  return 'over_50k';
}
