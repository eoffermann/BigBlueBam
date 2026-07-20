// The per-offer coverage adjudication (spec 3.5-3.8, 4, M5). PURE: given the confirmed tree, the
// offer's parsed lines, and the (window-merged) classifier answers, it composes Defenses 1-4, the
// three predicates, banding, and the §4.7 diff partition into a per-node decision set with NO db or
// LLM. This is the function the 20.2 corpus gates replay recorded answers into: split-blanket and
// single-blanket yield ZERO auto-published covered, the legitimate sub-priced bundle DOES, and the
// diff enumerates every mandatory node exactly once.

import {
  classifyCoverage,
  compositeConfidence,
  demoteByPredicates,
  evaluateCumulativeCaps,
  nodeTermOverlap,
  partitionDiff,
  validateRejectedCandidates,
  verifyCiteInOffer,
  canUpwardRollup,
  canDownwardSubsume,
  type AllocationMethod,
  type CapThresholds,
  type ClassifyPredicates,
  type CoverageDecision,
  type CumulativeCapVerdict,
  type DiffCoverageRow,
  type DiffPartition,
  type FanoutMatch,
  type OfferLineRef,
  type RejectedCandidate,
  type Verdict,
} from './leveling-logic.js';

export interface AdjudicationNode {
  scope_node_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  normative_strength: 'mandatory' | 'should_have' | 'nice_to_have' | 'informational';
}

export interface AdjudicationLine extends OfferLineRef {
  line_role: string | null;
  blanket_claim: boolean;
  exclusion_hit: boolean;
  extended_minor: number | null;
}

export interface AdjudicationAnswer {
  scope_node_id: string;
  verdict: Verdict;
  cited_offer_line_id: string | null;
  quote: string | null;
  classifier_confidence: number;
  rejected_candidates: RejectedCandidate[];
  /** The allocation method for the cited line (defaults to equal_split when unpriced). */
  allocation_method?: AllocationMethod | null;
  /** A per-node monetary sub-price on the cited line, in minor units (rung 1 valuation). */
  priced_amount_minor?: number | null;
  /** A human has confirmed this verdict (unblocks a mandatory absent regardless of parse). */
  human_confirmed?: boolean;
}

export interface AdjudicationOffer {
  offer_id: string;
  parse_quality: number | null;
  parse_quality_floor: number;
  blanket_suspected: boolean;
  injection_suspected: boolean;
}

export interface AdjudicationSettings extends CapThresholds {
  node_term_overlap_floor: number;
}

export interface NodeDecision {
  scope_node_id: string;
  decision: CoverageDecision;
  cited_offer_line_id: string | null;
  quote: string | null;
  matched_line_ids: string[];
  rejected_candidates: RejectedCandidate[];
  node_term_overlap: number;
  classifier_confidence: number;
  composite_confidence: number;
  span_verified: boolean;
  allocation_method: AllocationMethod | null;
  priced_amount_minor: number | null;
  derived_covered: boolean;
}

export interface AdjudicationResult {
  decisions: NodeDecision[];
  caps: CumulativeCapVerdict;
  diff: DiffPartition;
  /** For persistence on the offer row (recomputed from the real M5 verdicts). */
  unsubpriced_mandatory_count: number;
  evidence_concentration: number | null;
}

/**
 * Adjudicate one offer against the confirmed tree. `windowComplete` is false when some window of a
 * long offer was not classified (throttle / malformed), which precludes the high band and a
 * publishable mandatory absent. Deterministic and side-effect free.
 */
export function adjudicateOffer(
  offer: AdjudicationOffer,
  nodes: AdjudicationNode[],
  lines: AdjudicationLine[],
  answers: Map<string, AdjudicationAnswer>,
  settings: AdjudicationSettings,
  windowComplete: boolean,
): AdjudicationResult {
  const lineRefs: OfferLineRef[] = lines.map((l) => ({ offer_line_id: l.offer_line_id, raw_text: l.raw_text }));
  const offerLineIds = new Set(lines.map((l) => l.offer_line_id));
  const lineById = new Map(lines.map((l) => [l.offer_line_id, l]));
  const parseCleanForAbsent =
    windowComplete && offer.parse_quality != null && offer.parse_quality >= offer.parse_quality_floor;
  const suspected = offer.blanket_suspected || offer.injection_suspected;

  // ── Pass 1: per-node predicates + demoted verdict (used for caps + fan-out) ──────
  interface Prelim {
    node: AdjudicationNode;
    answer: AdjudicationAnswer;
    citedLine: AdjudicationLine | null;
    pred: ClassifyPredicates;
    demoted: Verdict;
    overlap: number;
    spanVerified: boolean;
    allocation_method: AllocationMethod | null;
  }
  const prelim: Prelim[] = [];
  for (const node of nodes) {
    const answer = answers.get(node.scope_node_id) ?? missingAnswer(node.scope_node_id);
    const citedLine = answer.cited_offer_line_id ? lineById.get(answer.cited_offer_line_id) ?? null : null;
    const spanVerified = verifyCiteInOffer(lineRefs, answer.cited_offer_line_id, answer.quote);
    const overlap = citedLine ? nodeTermOverlap(node.title, citedLine.raw_text) : 0;
    const rejectedValid = validateRejectedCandidates(answer.rejected_candidates, offerLineIds);
    const pred: ClassifyPredicates = {
      spanVerified,
      overlap,
      overlapFloor: settings.node_term_overlap_floor,
      rejectedValid,
    };
    prelim.push({
      node,
      answer,
      citedLine,
      pred,
      demoted: demoteByPredicates(answer.verdict, pred),
      overlap,
      spanVerified,
      allocation_method: answer.allocation_method ?? (answer.priced_amount_minor != null ? 'explicit_subprice' : null),
    });
  }

  // ── Defense 2 inputs: cumulative caps over covered MANDATORY nodes ───────────────
  const coveredMandatoryNodeIds = new Set<string>();
  const subpricedMandatoryNodeIds = new Set<string>();
  const coveredCitedLines = new Set<string>();
  const fanoutMatches: FanoutMatch[] = [];
  // Per cited line: how many nodes cite it with a covered/positive verdict (bundling detection).
  const lineNodeCount = new Map<string, number>();

  for (const p of prelim) {
    if (p.demoted === 'covered' || p.demoted === 'partial' || p.demoted === 'excluded_explicit') {
      if (p.answer.cited_offer_line_id) {
        lineNodeCount.set(p.answer.cited_offer_line_id, (lineNodeCount.get(p.answer.cited_offer_line_id) ?? 0) + 1);
        fanoutMatches.push({
          offer_line_id: p.answer.cited_offer_line_id,
          scope_node_id: p.node.scope_node_id,
          verdict: p.demoted,
          pinned: p.citedLine?.exclusion_hit ?? false,
        });
      }
    }
    if (p.node.normative_strength === 'mandatory' && p.demoted === 'covered') {
      coveredMandatoryNodeIds.add(p.node.scope_node_id);
      if (p.allocation_method === 'explicit_subprice') subpricedMandatoryNodeIds.add(p.node.scope_node_id);
      if (p.answer.cited_offer_line_id) coveredCitedLines.add(p.answer.cited_offer_line_id);
    }
  }

  const caps = evaluateCumulativeCaps(
    {
      coveredMandatoryNodeIds,
      subpricedMandatoryNodeIds,
      distinctCitedLines: coveredCitedLines.size,
      fanoutMatches,
    },
    settings,
  );

  // ── Pass 2: classify each node ────────────────────────────────────────────────────
  const decisions: NodeDecision[] = [];
  for (const p of prelim) {
    const bundlingNodeCount = p.answer.cited_offer_line_id ? lineNodeCount.get(p.answer.cited_offer_line_id) ?? 1 : 1;
    const evidenceStrength = evidenceStrengthFor(p.allocation_method, p.demoted);
    const score = compositeConfidence({
      evidence_strength: evidenceStrength,
      classifier_self_report: p.answer.classifier_confidence,
      span_verified_against_line: p.spanVerified,
      node_term_overlap: p.overlap,
      parse_quality: offer.parse_quality,
      window_coverage: windowComplete ? 1 : 0.5,
    });
    const decision = classifyCoverage(p.answer.verdict, p.pred, {
      strength: p.node.normative_strength,
      score,
      windowComplete,
      capTripped: caps.tripped && p.node.normative_strength === 'mandatory' && p.demoted === 'covered',
      capWithheldReason: caps.withheldReason,
      blanketClaimLine: p.citedLine?.blanket_claim ?? false,
      suspected,
      parseCleanForAbsent,
      humanConfirmed: p.answer.human_confirmed ?? false,
      bundlingNodeCount,
      allocationMethod: p.allocation_method,
    });
    decisions.push({
      scope_node_id: p.node.scope_node_id,
      decision,
      cited_offer_line_id: p.answer.cited_offer_line_id,
      quote: p.answer.quote,
      matched_line_ids: p.answer.cited_offer_line_id ? [p.answer.cited_offer_line_id] : [],
      rejected_candidates: p.answer.rejected_candidates,
      node_term_overlap: p.overlap,
      classifier_confidence: p.answer.classifier_confidence,
      composite_confidence: score,
      span_verified: p.spanVerified,
      allocation_method: p.allocation_method,
      priced_amount_minor: p.answer.priced_amount_minor ?? null,
      derived_covered: false,
    });
  }

  // ── Defense 3: subsumption + de-transitivized rollup ────────────────────────────
  applySubsumption(nodes, decisions);

  // ── §4.7 diff partition over MANDATORY nodes ────────────────────────────────────
  const coverageByNode = new Map<string, DiffCoverageRow>();
  for (const d of decisions) {
    coverageByNode.set(d.scope_node_id, {
      scope_node_id: d.scope_node_id,
      review_status: d.decision.reviewStatus,
      verdict: d.decision.verdict,
      withheld_reason: d.decision.withheldReason,
    });
  }
  const mandatoryIds = nodes.filter((n) => n.normative_strength === 'mandatory').map((n) => n.scope_node_id);
  const diff = partitionDiff(mandatoryIds, coverageByNode);

  return {
    decisions,
    caps,
    diff,
    unsubpriced_mandatory_count: caps.unsubpriced_mandatory_count,
    evidence_concentration: caps.evidence_concentration,
  };
}

function missingAnswer(scopeNodeId: string): AdjudicationAnswer {
  // A node the classifier never answered is `ambiguous`, never `absent` (spec 3.4). The engine
  // additionally retries it individually before falling back here.
  return {
    scope_node_id: scopeNodeId,
    verdict: 'ambiguous',
    cited_offer_line_id: null,
    quote: null,
    classifier_confidence: 0,
    rejected_candidates: [],
  };
}

function evidenceStrengthFor(method: AllocationMethod | null, verdict: Verdict): number {
  if (verdict === 'excluded_explicit') return 0.9; // an explicit exclusion is strong evidence
  switch (method) {
    case 'explicit_subprice':
      return 1;
    case 'rival_distribution':
      return 0.7;
    case 'quantity_unit':
      return 0.5;
    case 'equal_split':
      return 0.3;
    default:
      return verdict === 'covered' ? 0.4 : 0.5;
  }
}

/**
 * Defense 3 (spec 4.4). Downward subsumption is verdict-preserving (only promotes absent/ambiguous
 * children under a covered bundling parent, never overwrites excluded_explicit/partial, one level).
 * Upward rollup is de-transitivized (a parent whose children are all covered becomes
 * derived_covered, excluded from the diff, never itself a rollup input). Mutates `decisions`.
 */
function applySubsumption(nodes: AdjudicationNode[], decisions: NodeDecision[]): void {
  const byId = new Map(decisions.map((d) => [d.scope_node_id, d]));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent_id) {
      if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, []);
      childrenOf.get(n.parent_id)!.push(n.scope_node_id);
    }
  }

  // Downward: a covered parent promotes absent/ambiguous children one level.
  for (const n of nodes) {
    const parent = byId.get(n.scope_node_id);
    if (!parent || parent.decision.verdict !== 'covered') continue;
    for (const childId of childrenOf.get(n.scope_node_id) ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (canDownwardSubsume(child.decision.verdict)) {
        child.derived_covered = true;
        child.decision = { ...child.decision, reviewStatus: 'published', isGap: false, withheldReason: null };
      }
      // excluded_explicit / partial are never overwritten (verdict-preserving).
    }
  }

  // Upward: a parent whose children are ALL covered/derived_covered becomes derived_covered and is
  // excluded from the diff. Never itself a rollup input (single level; we do not re-walk to root).
  for (const [parentId, childIds] of childrenOf) {
    const parent = byId.get(parentId);
    if (!parent) continue;
    const childVerdicts = childIds
      .map((id) => byId.get(id))
      .filter((c): c is NodeDecision => !!c)
      .map((c) => (c.derived_covered ? ('covered' as Verdict) : c.decision.verdict));
    if (canUpwardRollup(childVerdicts) && parent.decision.verdict !== 'excluded_explicit') {
      parent.derived_covered = true;
      parent.decision = { ...parent.decision, reviewStatus: 'published', isGap: false, withheldReason: null };
    }
  }
}
