import { createHash } from 'node:crypto';

// Award / baseline-freeze pure logic (spec 7, M7). NO database, NO IO. This is the M5 pattern:
// the deterministic decisions live here and are unit-tested with plain inputs, while
// awards.service.ts does the org-scoped transaction that persists what these functions decide.
//
// Three things live here:
//   1. classifyBaselineKind + composeBaseline: turn the awarded offer's per-node coverage into
//      the FROZEN baseline ledger, one item per scope node, each `included` /
//      `excluded_at_award` / `absent_at_award`. The structural invariant the M7 "done when"
//      asserts (included + excluded_at_award + absent_at_award == node count) holds by
//      construction: every node yields exactly one item with one of the three kinds.
//   2. baselineHash: a deterministic SHA-256 over the frozen baseline content, so two freezes
//      of the same content produce the same hash and any edit produces a different one.
//   3. The chain helpers: freshAwardChain / amendAwardChain (spec 7.2 supersedes/chain_root)
//      and latestActivePerOrdinal (drift resolves over the chain, latest active item per
//      (chain_root_id, ordinal)).

/* ------------------------------------------------------------------ */
/*  Baseline kind classification                                      */
/* ------------------------------------------------------------------ */

export type BaselineKind = 'included' | 'excluded_at_award' | 'absent_at_award';

// The six coverage verdicts (mirrors services/engines/leveling-logic.ts Verdict). Kept as a
// local string union so this pure module has no engine import.
export type CoverageVerdict =
  | 'covered'
  | 'partial'
  | 'excluded_explicit'
  | 'absent'
  | 'ambiguous'
  | 'not_applicable';

/**
 * Map a per-node coverage verdict to the frozen baseline kind (spec 7.1).
 *
 *   covered / partial            -> included           (you got it, possibly with a term/qty delta)
 *   excluded_explicit            -> excluded_at_award   (the vendor said, in writing, they will NOT)
 *   not_applicable               -> excluded_at_award   (knowingly out of scope at award)
 *   absent / ambiguous / no row  -> absent_at_award     (never demonstrated: the record of what you
 *                                                        knowingly did not get)
 *
 * A missing coverage row (undefined) is `absent_at_award`, never silently dropped: the baseline
 * must account for every node so the M8 detectors measure reality against a complete record.
 */
export function classifyBaselineKind(verdict: CoverageVerdict | null | undefined): BaselineKind {
  switch (verdict) {
    case 'covered':
    case 'partial':
      return 'included';
    case 'excluded_explicit':
    case 'not_applicable':
      return 'excluded_at_award';
    // absent / ambiguous / null / undefined all fall through to the default: the record of what
    // was never demonstrated.
    default:
      return 'absent_at_award';
  }
}

/* ------------------------------------------------------------------ */
/*  Baseline composition                                              */
/* ------------------------------------------------------------------ */

export interface BaselineNodeInput {
  id: string;
  ordinal: number;
  title: string;
  description?: string | null;
  unit?: string | null;
  quantity?: string | number | null;
}

export interface BaselineCoverageInput {
  scope_node_id: string;
  verdict: CoverageVerdict;
  matched_line_ids?: string[] | null;
  cited_span?: unknown;
  delta_kind?: string | null;
  delta_amount_minor?: number | null;
}

export interface BaselineLineInput {
  id: string;
  unit?: string | null;
  quantity?: string | number | null;
  unit_price_minor?: number | null;
  extended_minor?: number | null;
  currency?: string | null;
}

/** A composed, frozen baseline item plus the scope node(s) it links to. `node_ids` feeds
 *  bursar_baseline_item_nodes; every other field is copied verbatim into bursar_baseline_items. */
export interface BaselineItemSpec {
  ordinal: number;
  kind: BaselineKind;
  title: string;
  description: string | null;
  unit: string | null;
  quantity: string | null;
  unit_price_minor: number | null;
  extended_minor: number | null;
  currency: string;
  delta_kind: string | null;
  delta_amount_minor: number | null;
  coverage_verdict_at_award: CoverageVerdict;
  source_offer_line_id: string | null;
  cited_span: unknown;
  node_ids: string[];
}

export interface ComposeBaselineArgs {
  nodes: BaselineNodeInput[];
  coverage: BaselineCoverageInput[];
  lines: BaselineLineInput[];
  /** The award currency, used when a node has no matched priced line to inherit from. */
  currency: string;
}

function normQuantity(q: string | number | null | undefined): string | null {
  if (q === null || q === undefined) return null;
  return typeof q === 'number' ? String(q) : q;
}

/**
 * Compose the frozen baseline: exactly one item per scope node, in node ordinal order, each
 * classified by the awarded offer's coverage verdict for that node (spec 7.1). Included items
 * inherit price/quantity from the first matched offer line; excluded/absent items carry no
 * price but keep any valued gap in delta_amount_minor. Pure and deterministic.
 */
export function composeBaseline(args: ComposeBaselineArgs): BaselineItemSpec[] {
  const covByNode = new Map<string, BaselineCoverageInput>();
  for (const c of args.coverage) covByNode.set(c.scope_node_id, c);
  const lineById = new Map<string, BaselineLineInput>();
  for (const l of args.lines) lineById.set(l.id, l);

  const ordered = [...args.nodes].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));

  return ordered.map((node) => {
    const cov = covByNode.get(node.id);
    const verdict: CoverageVerdict = cov?.verdict ?? 'absent';
    const kind = classifyBaselineKind(verdict);
    const firstLineId = cov?.matched_line_ids?.[0] ?? null;
    const line = firstLineId ? lineById.get(firstLineId) : undefined;
    const included = kind === 'included';
    return {
      ordinal: node.ordinal,
      kind,
      title: node.title,
      description: node.description ?? null,
      unit: line?.unit ?? node.unit ?? null,
      quantity: normQuantity(line?.quantity ?? node.quantity ?? null),
      // Price only meaningfully attaches to something you got.
      unit_price_minor: included ? line?.unit_price_minor ?? null : null,
      extended_minor: included ? line?.extended_minor ?? null : null,
      currency: line?.currency ?? args.currency,
      delta_kind: cov?.delta_kind ?? null,
      delta_amount_minor: cov?.delta_amount_minor ?? null,
      coverage_verdict_at_award: verdict,
      source_offer_line_id: line?.id ?? null,
      cited_span: cov?.cited_span ?? {},
      node_ids: [node.id],
    };
  });
}

/** The three-way count the M7 "done when" asserts equals the node count. */
export function baselineKindCounts(items: BaselineItemSpec[]): {
  included: number;
  excluded_at_award: number;
  absent_at_award: number;
  total: number;
} {
  let included = 0;
  let excluded = 0;
  let absent = 0;
  for (const it of items) {
    if (it.kind === 'included') included += 1;
    else if (it.kind === 'excluded_at_award') excluded += 1;
    else absent += 1;
  }
  return {
    included,
    excluded_at_award: excluded,
    absent_at_award: absent,
    total: included + excluded + absent,
  };
}

/* ------------------------------------------------------------------ */
/*  baseline_hash                                                     */
/* ------------------------------------------------------------------ */

export interface BaselineHashContext {
  request_id: string;
  offer_id: string | null;
  currency: string;
  term_start: string | null;
  term_end: string | null;
}

/**
 * Deterministic SHA-256 over the frozen baseline content (spec 7.1). Item order does NOT
 * affect the hash (items are sorted by ordinal, title, then sorted node ids before hashing),
 * so two freezes of the same content produce the same hash; any content change produces a
 * different one. The award-level context (request/offer/term/currency) is folded in so the
 * same line ledger under different terms is a different frozen record.
 */
export function baselineHash(items: BaselineItemSpec[], ctx: BaselineHashContext): string {
  const canonicalItems = [...items]
    .map((it) => ({
      ordinal: it.ordinal,
      kind: it.kind,
      title: it.title,
      description: it.description,
      unit: it.unit,
      quantity: it.quantity,
      unit_price_minor: it.unit_price_minor,
      extended_minor: it.extended_minor,
      currency: it.currency,
      delta_kind: it.delta_kind,
      delta_amount_minor: it.delta_amount_minor,
      coverage_verdict_at_award: it.coverage_verdict_at_award,
      node_ids: [...it.node_ids].sort(),
    }))
    .sort((a, b) => a.ordinal - b.ordinal || a.title.localeCompare(b.title) || a.node_ids.join(',').localeCompare(b.node_ids.join(',')));
  const payload = JSON.stringify({
    v: 1,
    request_id: ctx.request_id,
    offer_id: ctx.offer_id,
    currency: ctx.currency,
    term_start: ctx.term_start,
    term_end: ctx.term_end,
    items: canonicalItems,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  The award chain (spec 7.2)                                        */
/* ------------------------------------------------------------------ */

export interface AwardChainLinks {
  id: string;
  chain_root_id: string;
  supersedes_award_id: string | null;
}

/** A brand-new award is its own chain root: chain_root_id == id, no predecessor. */
export function freshAwardChain(newId: string): AwardChainLinks {
  return { id: newId, chain_root_id: newId, supersedes_award_id: null };
}

/**
 * An amendment inherits its predecessor's chain_root_id and points supersedes_award_id at the
 * predecessor (spec 7.2). The caller flips the predecessor to `superseded` in the same
 * transaction.
 */
export function amendAwardChain(
  newId: string,
  predecessor: { id: string; chain_root_id: string },
): AwardChainLinks {
  return {
    id: newId,
    chain_root_id: predecessor.chain_root_id,
    supersedes_award_id: predecessor.id,
  };
}

export interface ChainItemRef {
  chain_root_id: string;
  ordinal: number;
  /** award status the item belongs to; only `active` items resolve. */
  award_status: string;
  /** award recency within the chain; higher wins on a tie of (chain_root_id, ordinal). */
  award_sequence: number;
  value: unknown;
}

/**
 * Drift resolves over the chain: the latest ACTIVE item per (chain_root_id, ordinal) (spec 7.2).
 * Superseded and terminated award items never resolve. Pure; the M8 drift sweep applies it over
 * the materialized chain.
 */
export function latestActivePerOrdinal<T extends ChainItemRef>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    if (it.award_status !== 'active') continue;
    const key = `${it.chain_root_id}::${it.ordinal}`;
    const prev = best.get(key);
    if (!prev || it.award_sequence > prev.award_sequence) best.set(key, it);
  }
  return [...best.values()];
}
