// Deterministic structural line-to-node matching and the two per-offer counters (spec 4.3, M4),
// a PURE module. Stage 1 is deterministic: NO LLM. The LLM verdict classification is M5; here we
// compute only what a structural (term-containment) match yields, and persist the two counters
// that M5's load-bearing defense reads.
//
// Both counters are computed PER OFFER, not per line, so neither depends on the attacker's line
// count. The split attack (4 lines fanning to 14 mandatory nodes) trips both regardless of how
// the 14 are spread across lines.

import type { ParsedLine } from './parse-logic.js';

export interface ScopeNodeRef {
  id: string;
  title: string;
  normative_strength: string;
}

export interface LineNodeMatch {
  offer_line_ordinal: number;
  offer_line_id?: string;
  scope_node_id: string;
  /** How the match was made: `structural` term containment at this stage. */
  match_method: 'structural';
  /** Whether the matched line carried a distinct monetary sub-price for THIS node. At M4 a
   *  deterministic parser cannot attribute a per-node price, so this is always false: the LLM
   *  sub-price attribution is M5. Recorded so the counter recompute is honest about its inputs. */
  subpriced: boolean;
}

// Stopwords stripped from a node title before matching, so "On-site training" matches a line that
// says "training" without also demanding the noise words.
const STOPWORDS = new Set([
  'and',
  'or',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'in',
  'on',
  'with',
  'per',
  'at',
  'by',
  '24',
  'months',
  'month',
]);

export function significantTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Structural match test: a node matches a line when EVERY significant token of the node title
 * appears in the line text (subset containment). Deterministic and conservative: a line that does
 * not name a requirement's terms does not match it, so a real priced line only allocates to the
 * nodes it actually references. A node with no significant tokens never matches.
 */
export function lineMatchesNode(lineTextLower: string, nodeTokens: string[]): boolean {
  if (nodeTokens.length === 0) return false;
  return nodeTokens.every((tok) => lineTextLower.includes(tok));
}

/**
 * Match every BASE line against every node (spec 4.4: only `base` counts toward coverage). Option/
 * alternate/allowance/note lines never produce a coverage match. Returns the flat match set that
 * backs both §4.3 counters and (in M5) the coverage adjudication.
 */
export function matchLinesToNodes(lines: ParsedLine[], nodes: ScopeNodeRef[]): LineNodeMatch[] {
  const nodeTokens = nodes.map((n) => ({ node: n, tokens: significantTokens(n.title) }));
  const matches: LineNodeMatch[] = [];
  for (const line of lines) {
    if (line.line_role !== 'base') continue;
    const lower = line.raw_text.toLowerCase();
    for (const { node, tokens } of nodeTokens) {
      if (lineMatchesNode(lower, tokens)) {
        matches.push({
          offer_line_ordinal: line.ordinal,
          scope_node_id: node.id,
          match_method: 'structural',
          subpriced: false,
        });
      }
    }
  }
  return matches;
}

// ── The two per-offer counters (spec 4.3) ────────────────────────────────────

export interface PerOfferCounters {
  /** (a) distinct MANDATORY nodes whose only covered evidence is a non-sub-priced citation,
   *  across ALL lines of the offer. Above blanket_cumulative_cap they all route to review. */
  unsubpriced_mandatory_count: number;
  /** (b) distinct_cited_lines / covered_mandatory_nodes. Below evidence_concentration_floor all
   *  covered mandatory nodes route to review. null when there are no covered mandatory nodes. */
  evidence_concentration: number | null;
}

/**
 * Compute both counters from the match set + node strengths, PER OFFER. Recomputable: given the
 * persisted matches, lines, and nodes, this reproduces the same numbers, so the settings-cap
 * comparison at M5 can be re-run without re-parsing. Pure and deterministic.
 *
 * "Covered mandatory node" at M4 = a mandatory node with at least one structural base-line match.
 * "Unsub-priced" = every such node whose matches are all non-sub-priced (always, at M4, since the
 * deterministic parser attributes no per-node price). The definitions widen at M5 when real
 * coverage verdicts and explicit sub-pricing exist; the persisted shape does not change.
 */
export function computePerOfferCounters(
  matches: LineNodeMatch[],
  nodes: ScopeNodeRef[],
): PerOfferCounters {
  const mandatory = new Set(
    nodes.filter((n) => n.normative_strength === 'mandatory').map((n) => n.id),
  );
  const mandatoryMatches = matches.filter((m) => mandatory.has(m.scope_node_id));

  const coveredMandatoryNodes = new Set(mandatoryMatches.map((m) => m.scope_node_id));

  // A node is "subpriced" if ANY of its matches carried a distinct monetary sub-price. At M4 none
  // do, so every covered mandatory node is unsub-priced.
  const subpricedNodes = new Set(
    mandatoryMatches.filter((m) => m.subpriced).map((m) => m.scope_node_id),
  );
  let unsubpriced = 0;
  for (const nodeId of coveredMandatoryNodes) {
    if (!subpricedNodes.has(nodeId)) unsubpriced += 1;
  }

  const distinctCitedLines = new Set(mandatoryMatches.map((m) => m.offer_line_ordinal)).size;
  const coveredCount = coveredMandatoryNodes.size;
  const concentration =
    coveredCount === 0 ? null : Number((distinctCitedLines / coveredCount).toFixed(4));

  return {
    unsubpriced_mandatory_count: unsubpriced,
    evidence_concentration: concentration,
  };
}

// ── Cap comparison (spec 4.3) ────────────────────────────────────────────────
export interface CapThresholds {
  blanket_cumulative_cap: number;
  evidence_concentration_floor: number;
  blanket_fanout_cap: number;
}

export interface CapVerdict {
  tripped: boolean;
  reasons: Array<'cumulative_cap' | 'evidence_concentration' | 'per_line_fanout'>;
}

/**
 * Decide whether the offer trips any §4.3 cap. A trip sets bursar_offers.blanket_suspected and
 * opens an offer_manipulation_suspected finding at M4; M5 additionally routes the affected covered
 * mandatory nodes to review. Per-line fan-out is retained as a cheap early signal only.
 */
export function evaluateCaps(
  counters: PerOfferCounters,
  matches: LineNodeMatch[],
  thresholds: CapThresholds,
): CapVerdict {
  const reasons: CapVerdict['reasons'] = [];
  if (counters.unsubpriced_mandatory_count > thresholds.blanket_cumulative_cap) {
    reasons.push('cumulative_cap');
  }
  if (
    counters.evidence_concentration != null &&
    counters.evidence_concentration < thresholds.evidence_concentration_floor
  ) {
    reasons.push('evidence_concentration');
  }
  // Per-line fan-out: any single base line matched to more than blanket_fanout_cap nodes.
  const perLine = new Map<number, number>();
  for (const m of matches) {
    perLine.set(m.offer_line_ordinal, (perLine.get(m.offer_line_ordinal) ?? 0) + 1);
  }
  for (const count of perLine.values()) {
    if (count > thresholds.blanket_fanout_cap) {
      reasons.push('per_line_fanout');
      break;
    }
  }
  return { tripped: reasons.length > 0, reasons };
}
