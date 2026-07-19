// The ONE financial serializer. Spec 2.4 point 2 / 6.1 cross-cutting rule (a).
//
// ── WHY THIS IS CENTRALIZED, AND WHY PER-ROUTE FLOORING IS A BUG ──────────────────────
//
// Round 1 of the spec applied dollar flooring to /v1/work-items alone. /v1/attributions
// and /v1/unscoped project the SAME amounts through the work-item join and carried no
// annotation, so the identical disclosure ran on two unfloored routes. And the disclosure
// is not aggregate: for a single `bam.time_entry` row,
//
//     cost_amount / (minutes / 60)  IS that person's hourly cost rate to the cent
//
// which is the exact content of burn_cost_rates that spec section 13 promises never to
// expose. ONE ROW SUFFICED. That is why flooring lives here and never on a route.
//
// EVERY response containing a work-item or attribution projection passes through
// `redactFinancialFields`. The eight surfaces are enumerated in BURN_FLOORED_SURFACES
// below and asserted by name in test/redact-financial-fields.test.ts.
//
// ── HOW IT FLOORS ─────────────────────────────────────────────────────────────────────
//
// The floored keys are DELETED, not nulled and not banded (spec 2.4 point 17): a band plus
// the per-person hour vector Bam already exposes solves the cost-rate vector by least
// squares over a few daily snapshots, and a null still tells you the key exists. The walk
// is RECURSIVE because the payload shapes nest: burn_variances.detail is JSONB, the
// change-order body embeds a scope table, /v1/queue-health embeds bucket figures, and an
// unscoped cluster embeds its member rows. A shallow delete would floor the envelope and
// leave the same dollars one level down.
//
// NOTE: `fastify.canResolve` is NEVER consulted here. See lib/viewer-caps.ts for the full
// reason; short version, it is a hardcoded `return true` and using it would floor nothing.

import {
  BURN_READ_ALL_FLOORED_KEYS,
  BURN_READ_ALL_FLOORED_CLAUSE_KEYS,
  type BurnMoneyBlock,
  type BurnRevenueBasis,
  type BurnStoredMetricBasis,
  type BurnMarginState,
  type BurnSuppressedReason,
} from '@bigbluebam/shared';
import type { ViewerCaps } from './viewer-caps.js';

/**
 * The eight surfaces bound by spec 2.4 point 2. Enumerated as data so the test can assert
 * every one of them by NAME rather than spot-checking two and calling it covered, which is
 * exactly how round 1 shipped the hole.
 */
export const BURN_FLOORED_SURFACES = [
  '/v1/work-items',
  '/v1/attributions',
  '/v1/unscoped',
  '/v1/queue-health',
  '/v1/change-orders/:id',
  'burn_variances.detail',
  'mcp.tool_payload',
  'csv.export',
] as const;
export type BurnFlooredSurface = (typeof BURN_FLOORED_SURFACES)[number];

const FLOORED_KEYS: ReadonlySet<string> = new Set<string>(BURN_READ_ALL_FLOORED_KEYS);
const FLOORED_CLAUSE_KEYS: ReadonlySet<string> = new Set<string>(
  BURN_READ_ALL_FLOORED_CLAUSE_KEYS,
);

function isPlainish(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Map) &&
    !(value instanceof Set)
  );
}

export interface RedactOptions {
  /**
   * Also strip the clause-text keys (`description`, `clause_ref`, `cited_span.quote`) per
   * spec 2.4 point 5. Off by default because the eight money surfaces do not carry clause
   * text; the deliverable routes turn it on. `title` always survives as the
   * member-visible handle.
   */
  clauseText?: boolean;
}

function walk(value: unknown, caps: ViewerCaps, opts: RedactOptions, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, caps, opts, seen));
  }
  if (!isPlainish(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (FLOORED_KEYS.has(key)) continue;
    if (opts.clauseText && FLOORED_CLAUSE_KEYS.has(key)) continue;
    out[key] = walk(v, caps, opts, seen);
  }
  return out;
}

/**
 * THE SERIALIZER. Returns the row unchanged for a burn.financials.read_all caller, and a
 * deep copy with every floored key REMOVED for anyone else.
 *
 * Call it once on the whole response body, at the serializer layer. Do not call it
 * per-field, do not reimplement the key list on a route, and do not decide "this route has
 * no dollars so it can skip it" -- the change that adds a join is never the change that
 * remembers the flooring.
 */
export function redactFinancialFields<T>(row: T, caps: ViewerCaps, opts: RedactOptions = {}): T {
  if (caps.financials_read_all) return row;
  return walk(row, caps, opts, new WeakSet()) as T;
}

/** Convenience for list payloads. Identical semantics; kept so call sites read cleanly. */
export function redactFinancialRows<T>(rows: T[], caps: ViewerCaps, opts: RedactOptions = {}): T[] {
  return redactFinancialFields(rows, caps, opts);
}

/* ------------------------------------------------------------------ */
/*  The money block projection                                        */
/* ------------------------------------------------------------------ */

export interface MoneyFigures {
  /** The STORED basis. `suppressed` is a response shape and is never stored. */
  metric_basis: BurnStoredMetricBasis;
  revenue_basis: BurnRevenueBasis;
  currency: string;
  as_of: string;
  revenue_amount?: number | null;
  contract_value?: number | null;
  attributed_billable?: number | null;
  attributed_cost?: number | null;
  margin_amount?: number | null;
  margin_pct?: number | null;
  contract_consumption_pct?: number | null;
  cost_rate_coverage_pct?: number | null;
  margin_state?: BurnMarginState | null;
  /** From burn_engagement_rollups.distinct_contributor_count. */
  distinct_contributor_count: number;
  /** From burn_org_settings.min_contributors_for_cost_aggregate (default 3). */
  min_contributors_for_cost_aggregate: number;
}

/**
 * Project stored figures into the wire money block (spec 1.2.2).
 *
 * The whole point: a caller WITHOUT burn.financials.read_all can only ever receive the
 * `suppressed` variant, whose schema has no cost, margin, or coverage key to populate. It
 * is structurally impossible to leak a cost figure to a member through this function, as
 * opposed to conventionally discouraged.
 *
 * A read_all caller sees the figures even below the contributor floor (spec 2.4 point 17:
 * "Below min_contributors_for_cost_aggregate a read_all caller still sees the figures").
 * The floor is a disclosure control against members, not an accounting rule.
 */
export function buildMoneyBlock(figures: MoneyFigures, caps: ViewerCaps): BurnMoneyBlock {
  if (!caps.financials_read_all) {
    return {
      metric_basis: 'suppressed',
      suppressed_reason: suppressionReason(figures, caps),
      revenue_basis: figures.revenue_basis,
      currency: figures.currency,
      contract_consumption_pct: figures.contract_consumption_pct ?? null,
      as_of: figures.as_of,
    };
  }
  if (figures.metric_basis === 'contract_consumption') {
    return {
      metric_basis: 'contract_consumption',
      revenue_basis: figures.revenue_basis,
      currency: figures.currency,
      contract_value: figures.contract_value ?? null,
      attributed_billable: figures.attributed_billable ?? null,
      contract_consumption_pct: figures.contract_consumption_pct ?? null,
      cost_rate_coverage_pct: figures.cost_rate_coverage_pct ?? null,
      completion_state: figures.margin_state ?? null,
      as_of: figures.as_of,
    };
  }
  return {
    metric_basis: 'true_margin',
    revenue_basis: figures.revenue_basis,
    currency: figures.currency,
    revenue_amount: figures.revenue_amount ?? null,
    margin_amount: figures.margin_amount ?? null,
    margin_pct: figures.margin_pct ?? null,
    attributed_cost: figures.attributed_cost ?? null,
    attributed_billable: figures.attributed_billable ?? null,
    contract_consumption_pct: figures.contract_consumption_pct ?? null,
    cost_rate_coverage_pct: figures.cost_rate_coverage_pct ?? null,
    margin_state: figures.margin_state ?? null,
    as_of: figures.as_of,
  };
}

// Ordering matters only for the message, never for what is disclosed. An outage is named
// as an outage so an operator can tell a resolver blip from a permission denial; otherwise
// the chain's contributor count is the honest reason, which is the ordinary member response
// for any chain (spec 2.4 point 17).
function suppressionReason(figures: MoneyFigures, caps: ViewerCaps): BurnSuppressedReason {
  if (!caps.resolved) return 'unresolved_viewer';
  if (figures.distinct_contributor_count < figures.min_contributors_for_cost_aggregate) {
    return 'insufficient_contributors';
  }
  return 'insufficient_permission';
}
