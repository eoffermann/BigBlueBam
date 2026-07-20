// The pure absence-engine core (spec 3.4-3.8, 4, 10, M5). NO db/env/LLM import, so the graded
// 20.1 unit suite exercises every predicate, the classify decision table, the merge lattice, the
// four coverage-collapse defenses, the allocation + valuation ladders, and the diff-completeness
// partition directly against fixtures. `leveling.engine.ts` re-exports these and adds the
// async-start slice loop, the lease, claim fencing, and the LLM boundary; `leveling.store.ts`
// adds persistence. Everything here is side-effect free and deterministic.

/* ================================================================== */
/*  Verdicts, bands, and the window merge lattice                     */
/* ================================================================== */

export type Verdict =
  | 'covered'
  | 'partial'
  | 'excluded_explicit'
  | 'absent'
  | 'ambiguous'
  | 'not_applicable';

export type Band = 'high' | 'medium' | 'low';

/** The persisted review bucket. These are exactly the three states the §4.7 diff partitions. */
export type ReviewStatus = 'published' | 'needs_review' | 'unverified';

/** The §4.7 withheld reason persisted on coverage. varchar(24) on the row. */
export type WithheldReason = 'blanket_cap' | 'concentration' | 'band' | 'throttled' | 'unparseable';

/**
 * The window merge lattice (spec 3.8): per (offer, node) across windows, the HIGHEST wins.
 *
 *   excluded_explicit  >  partial  >  covered  >  ambiguous  >  absent
 *
 * `not_applicable` sits below `absent` (it never overrides a real signal). Ranked so a terminal
 * exclusion block hundreds of lines from the priced line still beats a `covered` from the priced
 * window, which is the whole point of pinning exclusions into every window.
 */
const LATTICE_ORDER: Verdict[] = [
  'excluded_explicit',
  'partial',
  'covered',
  'ambiguous',
  'absent',
  'not_applicable',
];

export function latticeRank(v: Verdict): number {
  const i = LATTICE_ORDER.indexOf(v);
  return i < 0 ? LATTICE_ORDER.length : i;
}

/** Merge two per-window verdicts for one (offer, node): the higher-ranked (lower index) wins. */
export function mergeVerdicts(a: Verdict, b: Verdict): Verdict {
  return latticeRank(a) <= latticeRank(b) ? a : b;
}

/** Fold a list of per-window verdicts to the single (offer, node) verdict. Empty -> `absent`. */
export function mergeVerdictList(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'absent';
  return verdicts.reduce((acc, v) => mergeVerdicts(acc, v));
}

/* ================================================================== */
/*  Stemming + Jaccard (predicate 3 support)                          */
/* ================================================================== */

const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'with', 'per', 'at', 'by',
  'is', 'are', 'be', 'as', 'all', 'any', 'this', 'that', 'from', 'into', 'shall', 'must',
]);

// A deliberately small, deterministic stemmer. Not linguistically perfect: it just has to fold
// "installation"/"install"/"installations" onto a shared root so the Jaccard is stable. Ordered
// longest-suffix-first so "ations" is stripped before "s".
const SUFFIXES = ['ations', 'ation', 'ings', 'ies', 'ing', 'ers', 'ment', 'ion', 'ed', 'es', 'er', 's'];

export function stem(token: string): string {
  let t = token;
  for (const suf of SUFFIXES) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) {
      t = t.slice(0, t.length - suf.length);
      break;
    }
  }
  return t;
}

/** Stemmed, stopword-filtered content tokens of a piece of text. Deterministic and pure. */
export function stemTokens(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Predicate 3 (spec 3.5): node-term overlap as Jaccard over stemmed tokens of the node title and
 * the cited line. `>= node_term_overlap_floor` (0.25 default) is required for a covered/partial/
 * excluded verdict to stand.
 *
 * PREDICATE 3 IS NOT THE DEFENSE AGAINST BLANKET COVERAGE. A blanket sentence that names the
 * requirements has MAXIMAL overlap by construction, so a high overlap tells you nothing about
 * whether the line actually prices the requirement. What predicate 3 catches is topically-adjacent
 * MIS-citation (the classifier cited a line about a different requirement). The blanket family is
 * defeated by the section 4 caps, which do not depend on language at all.
 */
export function nodeTermOverlap(nodeTitle: string, citedLineText: string): number {
  const a = new Set(stemTokens(nodeTitle));
  const b = new Set(stemTokens(citedLineText));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return Number((inter / union).toFixed(4));
}

/* ================================================================== */
/*  Predicate 1: cite verifies against the CITED LINE, not the doc    */
/* ================================================================== */

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Predicate 1 (spec 3.5, spec 5.1): the quote must be a substring of the ONE offer line the
 * classifier cited, never merely present somewhere in the document. Whitespace/case tolerant,
 * content-strict. An empty quote is a miss.
 */
export function verifyCiteAgainstLine(citedLineText: string | null | undefined, quote: string | null | undefined): boolean {
  if (!citedLineText || !quote || !quote.trim()) return false;
  return normalize(citedLineText).includes(normalize(quote));
}

export interface OfferLineRef {
  offer_line_id: string;
  raw_text: string;
}

/**
 * Look up the cited line by `offer_line_id` and verify the quote against ONLY that line. A cited
 * id that is not one of this offer's lines is a miss (an answer that cites a foreign line cannot
 * satisfy predicate 1). This is the version the engine calls; `verifyCiteAgainstLine` is its core.
 */
export function verifyCiteInOffer(
  lines: OfferLineRef[],
  citedOfferLineId: string | null | undefined,
  quote: string | null | undefined,
): boolean {
  if (!citedOfferLineId) return false;
  const line = lines.find((l) => l.offer_line_id === citedOfferLineId);
  if (!line) return false;
  return verifyCiteAgainstLine(line.raw_text, quote);
}

/* ================================================================== */
/*  Predicate 2: absent requires validated rejected candidates        */
/* ================================================================== */

export interface RejectedCandidate {
  offer_line_id: string;
  reason?: string;
}

/**
 * Predicate 2 (spec 3.5): an `absent` verdict requires a NON-EMPTY rejected-candidate set keyed by
 * `offer_line_id`, and every id must belong to THIS offer. A bare `absent` with no evidence can
 * never be published (mirrored by the bursar_offer_coverage_absent_check DB constraint). This is
 * the "we looked and here is what we rejected" record, so a false absence is auditable.
 */
export function validateRejectedCandidates(
  candidates: RejectedCandidate[] | null | undefined,
  offerLineIds: Set<string>,
): boolean {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  return candidates.every((c) => typeof c.offer_line_id === 'string' && offerLineIds.has(c.offer_line_id));
}

/* ================================================================== */
/*  Composite confidence (spec 3.6) - finite for EVERY input          */
/* ================================================================== */

export interface CompositeConfidenceInput {
  /** Ladder-derived evidence strength in [0,1] (rung 1 strongest). */
  evidence_strength: number | null | undefined;
  /** The classifier's own self-reported confidence in [0,1]. */
  classifier_self_report: number | null | undefined;
  /** Predicate 1 result. */
  span_verified_against_line: boolean;
  /** Predicate 3 raw overlap in [0,1]. */
  node_term_overlap: number | null | undefined;
  /** parse_quality in [0,1]; below `parse_quality_target` a penalty applies. */
  parse_quality: number | null | undefined;
  parse_quality_target?: number;
  /** window_coverage in [0,1]; below 1 a penalty applies. */
  window_coverage: number | null | undefined;
}

// Weights sum to 1.0 (spec 3.6). Penalties are subtracted after the weighted sum, then the score
// is clamped to [0,1]. Node-term overlap is already a hard predicate (predicate 3 gates the verdict
// at the floor), so it carries the SMALLEST score weight here - it is a tie-breaker, not the driver.
// Over-weighting it would sink a legitimately-cited exclusion whose line names both the requirement
// and the exclusion words (naturally diluting the Jaccard).
const W1 = 0.3; // evidence strength
const W2 = 0.25; // classifier self-report
const W3 = 0.3; // span verified against line
const W4 = 0.15; // node term overlap
const PARSE_PENALTY = 0.15;
const WINDOW_PENALTY = 0.15;

/** Coerce any input (null, undefined, NaN, Infinity, out-of-range) to a finite [0,1] number. */
function unit(x: number | null | undefined): number {
  if (x === null || x === undefined) return 0;
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * The banding score (spec 3.6). `test/confidence-no-nan.test.ts` asserts this is FINITE for every
 * input: null, undefined, NaN, Infinity, and out-of-range all coerce to a bounded contribution, so
 * the result is always a real number in [0,1]. A NaN score would silently sink a real gap or float
 * a fake one, so finiteness is a hard invariant, not a nicety.
 */
export function compositeConfidence(input: CompositeConfidenceInput): number {
  const target = Number.isFinite(input.parse_quality_target) ? (input.parse_quality_target as number) : 0.6;
  const evidence = unit(input.evidence_strength);
  const self = unit(input.classifier_self_report);
  const span = input.span_verified_against_line ? 1 : 0;
  const overlap = unit(input.node_term_overlap);
  const pq = unit(input.parse_quality);
  const wc = unit(input.window_coverage);

  let score = W1 * evidence + W2 * self + W3 * span + W4 * overlap;
  if (pq < target) score -= PARSE_PENALTY * (target - pq);
  if (wc < 1) score -= WINDOW_PENALTY * (1 - wc);

  if (!Number.isFinite(score)) return 0;
  const clamped = Math.max(0, Math.min(1, score));
  return Number(clamped.toFixed(4));
}

/* ================================================================== */
/*  Allocation-weight ladder (spec 4.4)                               */
/* ================================================================== */

export type AllocationMethod = 'explicit_subprice' | 'rival_distribution' | 'quantity_unit' | 'equal_split';

const ALLOCATION_RUNG: Record<AllocationMethod, number> = {
  explicit_subprice: 1,
  rival_distribution: 2,
  quantity_unit: 3,
  equal_split: 4,
};

export function allocationRung(method: AllocationMethod): number {
  return ALLOCATION_RUNG[method];
}

/**
 * Only rung 1 (`explicit_subprice`) ENUMERATES (spec 4.4): it is the only method by which a
 * bundling line may auto-publish `covered` for more than one node. The other rungs allocate a
 * weight but never enumerate.
 */
export function enumerates(method: AllocationMethod): boolean {
  return method === 'explicit_subprice';
}

/**
 * Whether a rung may drive gap VALUATION (spec 4.4 / 10.1). Rung 4 (`equal_split`) is REFUSED: an
 * equal split of a $16,400 turnkey line across 12 nodes gives $1,367/node, and the flagship gap
 * number must never be an artifact of that heuristic. Rung 4 exists only so the model is total.
 */
export function usableForGapValuation(method: AllocationMethod): boolean {
  return method !== 'equal_split';
}

/**
 * Distribute an allocation weight across `n` matched nodes so the weights per line sum to 1.0
 * (spec 4.4). `explicit_subprice` uses the caller-supplied sub-price proportions; every other
 * method falls back to an equal split. The last node absorbs the rounding residue so the sum is
 * EXACTLY 1.0 rather than 0.99998.
 */
export function allocationWeights(
  method: AllocationMethod,
  n: number,
  subprices?: number[],
): number[] {
  if (n <= 0) return [];
  if (n === 1) return [1];
  if (method === 'explicit_subprice' && subprices && subprices.length === n) {
    const total = subprices.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
    if (total > 0) {
      const raw = subprices.map((p) => (Number.isFinite(p) && p > 0 ? p : 0) / total);
      return normalizeToOne(raw);
    }
  }
  return normalizeToOne(new Array(n).fill(1 / n));
}

function normalizeToOne(weights: number[]): number[] {
  const rounded = weights.map((w) => Number(w.toFixed(5)));
  const sum = rounded.reduce((a, b) => a + b, 0);
  const residue = Number((1 - sum).toFixed(5));
  if (rounded.length > 0) rounded[rounded.length - 1] = Number((rounded[rounded.length - 1]! + residue).toFixed(5));
  return rounded;
}

/* ================================================================== */
/*  Exclusion pinning + the scoped fan-out exemption (spec 3.8/4.3)   */
/* ================================================================== */

export interface FanoutMatch {
  offer_line_id: string;
  scope_node_id: string;
  /** The verdict this line produced for this node (post-merge). */
  verdict: Verdict;
  /** Whether the line was pinned into every window because it hit the exclusion lexicon. */
  pinned: boolean;
}

/**
 * The per-line fan-out count with the SCOPED pinning exemption (spec 3.8). A pinned line's matches
 * count toward fan-out UNLESS the resulting verdict is `excluded_explicit`. The exemption exists so
 * a real terminal exclusions block (pinned everywhere) does not read as a blanket-coverage attack,
 * but it is scoped to the verdict it exists for: "Nothing is excluded: installation, crew training
 * and warranty are all provided under this price" takes the exclusion_hit flag and gets pinned, yet
 * its verdict is `covered`, so it STILL counts toward fan-out and cannot escape the defense.
 */
export function effectiveFanoutMatches(matches: FanoutMatch[]): FanoutMatch[] {
  return matches.filter((m) => !(m.pinned && m.verdict === 'excluded_explicit'));
}

/** The maximum per-line fan-out (distinct nodes) after the scoped pinning exemption. */
export function maxLineFanout(matches: FanoutMatch[]): number {
  const perLine = new Map<string, Set<string>>();
  for (const m of effectiveFanoutMatches(matches)) {
    if (!perLine.has(m.offer_line_id)) perLine.set(m.offer_line_id, new Set());
    perLine.get(m.offer_line_id)!.add(m.scope_node_id);
  }
  let max = 0;
  for (const nodes of perLine.values()) max = Math.max(max, nodes.size);
  return max;
}

/* ================================================================== */
/*  Defense 2: cumulative per-offer caps (spec 4.3)                   */
/* ================================================================== */

export interface CapThresholds {
  blanket_cumulative_cap: number;
  evidence_concentration_floor: number;
  blanket_fanout_cap: number;
}

export interface CumulativeCapInput {
  /** Distinct MANDATORY node ids with a `covered` verdict. */
  coveredMandatoryNodeIds: Set<string>;
  /** Of those, the ones whose ONLY covered evidence is explicitly sub-priced. */
  subpricedMandatoryNodeIds: Set<string>;
  /** Distinct offer lines that produced a covered mandatory verdict. */
  distinctCitedLines: number;
  /** The post-exemption fan-out matches, for the cheap per-line early signal. */
  fanoutMatches: FanoutMatch[];
}

export interface CumulativeCapVerdict {
  tripped: boolean;
  reasons: Array<'cumulative_cap' | 'evidence_concentration' | 'per_line_fanout'>;
  /** The §4.7 withheld reason to persist when the cap routes covered nodes to review. */
  withheldReason: 'blanket_cap' | 'concentration' | null;
  unsubpriced_mandatory_count: number;
  evidence_concentration: number | null;
}

/**
 * Defense 2, the LOAD-BEARING defense (spec 4.3). Two guards, both PER OFFER so neither depends on
 * the attacker's line count:
 *
 *   (a) unsubpriced-coverage cap: count distinct mandatory nodes whose only `covered` evidence is a
 *       non-sub-priced citation. Above `blanket_cumulative_cap` (4), ALL covered mandatory nodes
 *       route to review. The split attack yields 14 such nodes and trips immediately.
 *   (b) evidence-concentration guard: distinct_cited_lines / covered_mandatory_nodes below
 *       `evidence_concentration_floor` (0.5) routes all covered mandatory nodes to review. Four
 *       lines covering 14 nodes gives 0.29.
 *
 * Per-line fan-out (`blanket_fanout_cap`) is retained only as a cheap early signal, not the
 * boundary.
 */
export function evaluateCumulativeCaps(
  input: CumulativeCapInput,
  thresholds: CapThresholds,
): CumulativeCapVerdict {
  const covered = input.coveredMandatoryNodeIds.size;
  let unsubpriced = 0;
  for (const id of input.coveredMandatoryNodeIds) {
    if (!input.subpricedMandatoryNodeIds.has(id)) unsubpriced += 1;
  }
  const concentration = covered === 0 ? null : Number((input.distinctCitedLines / covered).toFixed(4));

  const reasons: CumulativeCapVerdict['reasons'] = [];
  let withheldReason: 'blanket_cap' | 'concentration' | null = null;

  if (unsubpriced > thresholds.blanket_cumulative_cap) {
    reasons.push('cumulative_cap');
    withheldReason = 'blanket_cap';
  }
  if (concentration !== null && concentration < thresholds.evidence_concentration_floor) {
    reasons.push('evidence_concentration');
    if (withheldReason === null) withheldReason = 'concentration';
  }
  if (maxLineFanout(input.fanoutMatches) > thresholds.blanket_fanout_cap) {
    reasons.push('per_line_fanout');
  }

  return {
    tripped: reasons.length > 0,
    reasons,
    withheldReason,
    unsubpriced_mandatory_count: unsubpriced,
    evidence_concentration: concentration,
  };
}

/* ================================================================== */
/*  Defense 3: subsumption + rollup (spec 4.4)                        */
/* ================================================================== */

/**
 * DOWNWARD subsumption (spec 4.4), verdict-PRESERVING: a bundling parent's coverage may only
 * promote an `absent`/`ambiguous` child to `derived_covered`. It may NEVER overwrite an
 * `excluded_explicit` or `partial` child (an explicit exclusion is a fact, not a gap to paper
 * over). Returns whether the child becomes `derived_covered`.
 */
export function canDownwardSubsume(childVerdict: Verdict): boolean {
  return childVerdict === 'absent' || childVerdict === 'ambiguous';
}

/**
 * UPWARD rollup (spec 4.4), DE-TRANSITIVIZED: a parent whose children are ALL covered (or already
 * derived_covered) becomes `derived_covered`, is excluded from the diff, and is NEVER itself a
 * rollup input. Round 1's rule composed recursively up to the root; this one is capped at one
 * level so a single covered leaf cannot silently mark a whole subtree covered.
 */
export function canUpwardRollup(childVerdicts: Verdict[]): boolean {
  if (childVerdicts.length === 0) return false;
  return childVerdicts.every((v) => v === 'covered' || v === 'derived_covered' as unknown as Verdict);
}

/* ================================================================== */
/*  The classify decision table (spec 3.5/3.6/4) - the master fn      */
/* ================================================================== */

export interface ClassifyPredicates {
  spanVerified: boolean;
  overlap: number;
  overlapFloor: number;
  rejectedValid: boolean;
}

export interface ClassifyContext {
  strength: 'mandatory' | 'should_have' | 'nice_to_have' | 'informational';
  score: number;
  windowComplete: boolean;
  /** A section-4 cumulative cap tripped for this offer. */
  capTripped: boolean;
  capWithheldReason: 'blanket_cap' | 'concentration' | null;
  /** The cited line hit the blanket-claim lexicon (Defense 1). */
  blanketClaimLine: boolean;
  /** blanket_suspected || injection_suspected on the offer (spec 3.6). */
  suspected: boolean;
  /** For `absent`: offer parsed cleanly (parse_quality >= floor) AND window coverage complete. */
  parseCleanForAbsent: boolean;
  /** A human confirmed this verdict. */
  humanConfirmed: boolean;
  /** How many distinct nodes the cited line matched (>1 => a bundling line, spec 4.4). */
  bundlingNodeCount: number;
  /** The allocation method of the cited bundling line. */
  allocationMethod: AllocationMethod | null;
}

export interface CoverageDecision {
  /** The final verdict after predicate demotion. */
  verdict: Verdict;
  band: Band;
  reviewStatus: ReviewStatus;
  withheldReason: WithheldReason | null;
  autoPublished: boolean;
  /** Whether this (mandatory) node contributes a row to the exclusion diff as a GAP. */
  isGap: boolean;
}

function overlapPasses(pred: ClassifyPredicates): boolean {
  return pred.overlap >= pred.overlapFloor;
}

/**
 * Predicate demotion (spec 3.5): any predicate failure demotes a positive citing verdict
 * (covered/partial/excluded_explicit) to `ambiguous`, and an `absent` with no validated
 * rejected-candidate set to `ambiguous`. Exported so the adjudicator can compute the demoted
 * verdict once (for caps + fan-out) and `classifyCoverage` reuses it, keeping one source of truth.
 */
export function demoteByPredicates(raw: Verdict, pred: ClassifyPredicates): Verdict {
  const overlapOk = overlapPasses(pred);
  if (raw === 'covered' || raw === 'partial' || raw === 'excluded_explicit') {
    return !pred.spanVerified || !overlapOk ? 'ambiguous' : raw;
  }
  if (raw === 'absent') {
    return !pred.rejectedValid ? 'ambiguous' : raw;
  }
  return raw;
}

/**
 * The master classify function (spec 3.5, 3.6, 4). Six verdicts x three predicates x four
 * strengths. Deterministic and pure. Order:
 *   1. Predicate demotion: any predicate failure demotes covered/partial/excluded_explicit to
 *      ambiguous; an unbacked `absent` demotes to ambiguous (predicate 2).
 *   2. Band from the score plus the high-band preconditions (all predicates, window complete, no
 *      §4 cap).
 *   3. Auto-publish per verdict, honoring Defenses 1/3, the suspicion gate on `covered` only, and
 *      the asymmetric mandatory-absent rule.
 */
export function classifyCoverage(
  raw: Verdict,
  pred: ClassifyPredicates,
  ctx: ClassifyContext,
): CoverageDecision {
  const overlapOk = overlapPasses(pred);

  // ── 1. predicate demotion ──────────────────────────────────────────
  const verdict = demoteByPredicates(raw, pred);

  // "All predicates pass" for banding: the citing predicates for a positive verdict, or the
  // rejected-candidate predicate for absence.
  const allPredicates =
    verdict === 'absent'
      ? pred.rejectedValid
      : verdict === 'not_applicable'
        ? true
        : pred.spanVerified && overlapOk;

  // ── 2. band ─────────────────────────────────────────────────────────
  let band: Band;
  if (verdict === 'ambiguous') {
    band = 'low';
  } else if (allPredicates && ctx.windowComplete && ctx.score >= 0.85) {
    band = ctx.capTripped ? 'medium' : 'high';
  } else if (ctx.score >= 0.6 && ctx.score < 0.85) {
    band = 'medium';
  } else if (ctx.score >= 0.85) {
    // score is high but a precondition failed (window incomplete): not auto-publishable.
    band = 'medium';
  } else {
    band = 'low';
  }

  // ── 3. per-verdict publication ──────────────────────────────────────
  // Defense 3: a bundling line (>1 node) may auto-publish `covered` for >1 node ONLY at
  // explicit_subprice. A name-only list is a restatement, not evidence.
  const bundlingBlocksCovered =
    ctx.bundlingNodeCount > 1 && ctx.allocationMethod !== 'explicit_subprice';

  let reviewStatus: ReviewStatus = 'needs_review';
  let withheldReason: WithheldReason | null = null;
  let autoPublished = false;
  let isGap = false;

  switch (verdict) {
    case 'covered': {
      // Defense 1 (blanket lexicon), the suspicion gate (spec 3.6, `covered` only), Defense 2
      // (cumulative caps), Defense 3 (bundling), and the band bar all gate auto-publish.
      const blocked =
        band !== 'high' ||
        ctx.blanketClaimLine ||
        ctx.suspected ||
        ctx.capTripped ||
        bundlingBlocksCovered;
      if (!blocked) {
        autoPublished = true;
        reviewStatus = 'published';
      } else {
        reviewStatus = 'needs_review';
        withheldReason = ctx.capTripped
          ? ctx.capWithheldReason ?? 'blanket_cap'
          : ctx.blanketClaimLine
            ? 'blanket_cap'
            : band !== 'high'
              ? 'band'
              : null;
      }
      // A covered node is not a gap.
      isGap = false;
      break;
    }
    case 'excluded_explicit': {
      // An explicit exclusion IS a gap and is published to the diff on a clear high band. The
      // suspicion gate does NOT block it (only `covered`); an exclusion is evidence FOR a gap.
      if (band === 'high') {
        autoPublished = true;
        reviewStatus = 'published';
      } else {
        reviewStatus = 'needs_review';
        withheldReason = 'band';
      }
      isGap = true;
      break;
    }
    case 'partial': {
      // A partial contributes a delta to gap_adjusted. Publishes on a clear high band.
      if (band === 'high') {
        autoPublished = true;
        reviewStatus = 'published';
      } else {
        reviewStatus = 'needs_review';
        withheldReason = 'band';
      }
      isGap = true;
      break;
    }
    case 'absent': {
      // The asymmetric mandatory-absent rule (spec 3.6). An absence has no positive citation, so
      // the fuzzy confidence score is low BY CONSTRUCTION; the band therefore does NOT gate it.
      // Publishability is exactly the asymmetric rule: the genuine "we could not read it" conditions
      // (clean parse + complete window) OR a human. Suspicion flags do NOT gate absent - a blanket
      // claim is evidence FOR absence, not against it. Non-mandatory absent is informational.
      const publishable =
        ctx.strength === 'mandatory' && (ctx.parseCleanForAbsent || ctx.humanConfirmed);
      if (publishable) {
        autoPublished = true;
        reviewStatus = 'published';
        band = 'high'; // a clean, complete search that rejected every candidate is high-confidence
      } else {
        reviewStatus = 'needs_review';
        withheldReason = ctx.parseCleanForAbsent ? 'band' : 'unparseable';
      }
      isGap = ctx.strength === 'mandatory';
      break;
    }
    case 'ambiguous': {
      // Never published; HITL.
      reviewStatus = 'needs_review';
      withheldReason = 'band';
      isGap = ctx.strength === 'mandatory';
      break;
    }
    case 'not_applicable': {
      // The node does not apply to this offer: a cleared, non-gap verdict.
      reviewStatus = 'published';
      autoPublished = true;
      isGap = false;
      break;
    }
  }

  return { verdict, band, reviewStatus, withheldReason, autoPublished, isGap };
}

/* ================================================================== */
/*  §4.7 diff-completeness partition                                  */
/* ================================================================== */

export interface DiffCoverageRow {
  scope_node_id: string;
  review_status: ReviewStatus;
  verdict: Verdict;
  withheld_reason: WithheldReason | null;
}

export interface DiffPartition {
  published: string[];
  needs_review: string[];
  unverified: string[];
  /** published + needs_review + unverified. MUST equal mandatoryNodeIds.length. */
  total: number;
  complete: boolean;
}

/**
 * THE §4.7 DIFF-COMPLETENESS INVARIANT. For a confirmed tree, the exclusion diff enumerates every
 * mandatory node EXACTLY ONCE in exactly one of `published`, `needs_review`, `unverified`, and
 * `published + needs_review + unverified == count(mandatory nodes)`. A mandatory node with no
 * coverage row, or one whose classification never completed, is `unverified` - it NEVER simply
 * vanishes from the diff, because a silent omission is exactly the attacker's goal (spec 4.7).
 *
 * This function is the pure core the `/exclusion-diff` route and the CI gate both call.
 */
export function partitionDiff(
  mandatoryNodeIds: string[],
  coverageByNode: Map<string, DiffCoverageRow>,
): DiffPartition {
  const published: string[] = [];
  const needs_review: string[] = [];
  const unverified: string[] = [];
  for (const nodeId of mandatoryNodeIds) {
    const row = coverageByNode.get(nodeId);
    if (!row) {
      unverified.push(nodeId);
    } else if (row.review_status === 'published') {
      published.push(nodeId);
    } else if (row.review_status === 'needs_review') {
      needs_review.push(nodeId);
    } else {
      unverified.push(nodeId);
    }
  }
  const total = published.length + needs_review.length + unverified.length;
  return { published, needs_review, unverified, total, complete: total === mandatoryNodeIds.length };
}
