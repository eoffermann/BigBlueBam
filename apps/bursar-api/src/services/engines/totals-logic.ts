// Comparable totals + the valuation ladder with admissibility (spec 10, M5). A PURE module: the
// 20.1 totals unit suite exercises admissibility, the "median needs >= 2 observations" rule, the
// different-currency refusal, equal-split refusal, and `renderable=false` against fixtures with no
// db. `leveling.store.ts` persists the four bursar_offer_totals rows this produces.

import { usableForGapValuation, type AllocationMethod } from './leveling-logic.js';

export type TotalKind = 'stated' | 'base_only' | 'gap_adjusted' | 'should_have_supplement';
export type ValuationRung = 'offer_line' | 'rival_median' | 'library_unit' | 'unvalued';

/* ================================================================== */
/*  The valuation ladder (spec 10.1)                                  */
/* ================================================================== */

export interface ValuationObservation {
  /** The gap value in minor units, in `currency`. */
  amount_minor: number;
  currency: string;
  /** How the observation was priced. `equal_split` observations are inadmissible (spec 10.1). */
  allocation_method?: AllocationMethod | null;
  /** A rival that is itself `absent` contributes nothing; caller passes only real observations. */
  source: 'this_offer' | 'rival' | 'library';
}

export interface ValuationInput {
  currency: string;
  /** This offer priced the node as an option/allowance: one observation suffices (rung 1). */
  offerLine?: { amount_minor: number; currency: string } | null;
  /** Rival separate prices for the same node (rung 2). */
  rivalObservations?: ValuationObservation[];
  /** node.quantity x library unit price (rung 3). */
  libraryUnit?: { amount_minor: number; currency: string } | null;
}

export interface ValuationResult {
  rung: ValuationRung;
  amount_minor: number | null;
  estimated: boolean;
  /** The admissible observations that fed the chosen rung (for provenance). */
  observations: number;
}

/**
 * An observation is admissible (spec 10.1) when it is in the SAME currency as the offer being
 * valued (a different-currency rival is inadmissible, matching §7.3) and was NOT priced by an
 * equal split (rung 4 is refused for valuation). A rival pricing the node inside a bundle
 * contributes only at explicit_subprice or rival_distribution, which the caller enforces by only
 * passing admissible observations, but the currency + equal-split checks are repeated here as the
 * single admissibility gate.
 */
export function isAdmissibleObservation(obs: ValuationObservation, currency: string): boolean {
  if (obs.currency !== currency) return false;
  if (obs.allocation_method && !usableForGapValuation(obs.allocation_method)) return false;
  if (!Number.isFinite(obs.amount_minor)) return false;
  return true;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Value a single mandatory gap by descending the ladder (spec 10.1):
 *   rung 1 `offer_line`    - this offer priced it, one observation suffices (it is the vendor's own
 *                            price), always admissible when same-currency.
 *   rung 2 `rival_median`  - median across rivals pricing it separately, REQUIRES >= 2 admissible
 *                            observations. With two offers the "median" is one observation, which
 *                            is refused.
 *   rung 3 `library_unit`  - node quantity x library unit price, `estimated`.
 *   else   `unvalued`.
 */
export function valueGap(input: ValuationInput): ValuationResult {
  // Rung 1: this offer's own price.
  if (input.offerLine && input.offerLine.currency === input.currency && Number.isFinite(input.offerLine.amount_minor)) {
    return { rung: 'offer_line', amount_minor: input.offerLine.amount_minor, estimated: false, observations: 1 };
  }
  // Rung 2: rival median, needs >= 2 admissible observations.
  const admissible = (input.rivalObservations ?? []).filter((o) => isAdmissibleObservation(o, input.currency));
  if (admissible.length >= 2) {
    return {
      rung: 'rival_median',
      amount_minor: median(admissible.map((o) => o.amount_minor)),
      estimated: false,
      observations: admissible.length,
    };
  }
  // Rung 3: library unit price (estimated).
  if (input.libraryUnit && input.libraryUnit.currency === input.currency && Number.isFinite(input.libraryUnit.amount_minor)) {
    return { rung: 'library_unit', amount_minor: input.libraryUnit.amount_minor, estimated: true, observations: 1 };
  }
  return { rung: 'unvalued', amount_minor: null, estimated: false, observations: 0 };
}

/* ================================================================== */
/*  Comparable totals (spec 10)                                       */
/* ================================================================== */

export interface GapForTotal {
  scope_node_id: string;
  strength: 'mandatory' | 'should_have' | 'nice_to_have' | 'informational';
  /** covered/partial/excluded_explicit/absent - only mandatory gaps feed gap_adjusted. */
  verdict: string;
  valuation: ValuationResult;
  /** For a `partial`, its delta_amount_minor (spec 3.7); overrides the ladder when present. */
  delta_amount_minor?: number | null;
}

export interface TotalsInput {
  currency: string;
  /** Sum of `line_role='base'` lines in minor units. */
  base_only_minor: number;
  /** What the vendor's document states (may differ from base_only). */
  stated_minor: number | null;
  gaps: GapForTotal[];
}

export interface ComputedTotal {
  total_kind: TotalKind;
  currency: string;
  amount_minor: number | null;
  estimated: boolean;
  unvalued_gap_count: number;
  renderable: boolean;
  provenance: Record<string, unknown>;
}

/**
 * Compute the four comparable totals (spec 10). `gap_adjusted` = base_only + valued MANDATORY gaps
 * (`absent`, `excluded_explicit`, and `partial` via delta_amount_minor). `should_have_supplement`
 * is the same over `should_have` nodes, reported SEPARATELY. `normalized_to_term` is NOT built in
 * v1.
 *
 * Refusing to render a number (spec 10.2): when any mandatory gap cannot be valued above rung 3
 * (i.e. it is `unvalued`), `gap_adjusted.renderable = false`. The Matrix then does NOT sort on
 * `gap_adjusted`; it falls back to `stated` plus an unpriced-gap count. Fabricating a total from a
 * refused rung to preserve a headline is the CFO-credibility failure the product refuses.
 */
export function computeTotals(input: TotalsInput): ComputedTotal[] {
  const mandatoryGaps = input.gaps.filter(
    (g) =>
      g.strength === 'mandatory' &&
      (g.verdict === 'absent' || g.verdict === 'excluded_explicit' || g.verdict === 'partial'),
  );
  const shouldHaveGaps = input.gaps.filter(
    (g) =>
      g.strength === 'should_have' &&
      (g.verdict === 'absent' || g.verdict === 'excluded_explicit' || g.verdict === 'partial'),
  );

  const mandatory = sumGaps(mandatoryGaps);
  const shouldHave = sumGaps(shouldHaveGaps);

  const gapAdjustedAmount = mandatory.renderable ? input.base_only_minor + mandatory.valued : null;

  return [
    {
      total_kind: 'stated',
      currency: input.currency,
      amount_minor: input.stated_minor,
      estimated: false,
      unvalued_gap_count: 0,
      renderable: input.stated_minor !== null,
      provenance: { source: 'vendor_document' },
    },
    {
      total_kind: 'base_only',
      currency: input.currency,
      amount_minor: input.base_only_minor,
      estimated: false,
      unvalued_gap_count: 0,
      renderable: true,
      provenance: { source: 'sum_base_lines' },
    },
    {
      total_kind: 'gap_adjusted',
      currency: input.currency,
      amount_minor: gapAdjustedAmount,
      estimated: mandatory.estimated,
      unvalued_gap_count: mandatory.unvalued,
      // renderable ONLY when every mandatory gap valued above rung 3 (spec 10.2).
      renderable: mandatory.renderable,
      provenance: { base_only_minor: input.base_only_minor, valued_gaps_minor: mandatory.valued, rungs: mandatory.rungs },
    },
    {
      total_kind: 'should_have_supplement',
      currency: input.currency,
      amount_minor: shouldHave.renderable ? shouldHave.valued : null,
      estimated: shouldHave.estimated,
      unvalued_gap_count: shouldHave.unvalued,
      renderable: shouldHave.renderable,
      provenance: { valued_gaps_minor: shouldHave.valued, rungs: shouldHave.rungs },
    },
  ];
}

function sumGaps(gaps: GapForTotal[]): {
  valued: number;
  unvalued: number;
  estimated: boolean;
  renderable: boolean;
  rungs: Record<string, number>;
} {
  let valued = 0;
  let unvalued = 0;
  let estimated = false;
  const rungs: Record<string, number> = {};
  for (const g of gaps) {
    // A partial with an explicit delta uses it directly (spec 3.7 / 10).
    if (g.verdict === 'partial' && g.delta_amount_minor != null && Number.isFinite(g.delta_amount_minor)) {
      valued += g.delta_amount_minor;
      rungs.delta = (rungs.delta ?? 0) + 1;
      continue;
    }
    if (g.valuation.rung === 'unvalued' || g.valuation.amount_minor == null) {
      unvalued += 1;
      continue;
    }
    valued += g.valuation.amount_minor;
    if (g.valuation.estimated) estimated = true;
    rungs[g.valuation.rung] = (rungs[g.valuation.rung] ?? 0) + 1;
  }
  // renderable when NO gap is unvalued: every mandatory gap valued above rung 3 (spec 10.2).
  return { valued, unvalued, estimated, renderable: unvalued === 0, rungs };
}
