// The ONE financial serializer for Bursar. Ported from burn-api/src/lib/redact-financial-
// fields.ts (spec 5.6 / 13.3).
//
// ── WHY THIS IS CENTRALIZED, AND WHY PER-ROUTE FLOORING IS A BUG ──────────────────────
//
// Round 2 of the burn/bursar lineage enumerated endpoints and then added two CSV exports and
// four MCP read tools that bypassed the floor, reopening the finding at new surfaces. A
// shared serializer cannot be forgotten by a new route. EVERY response containing a spend /
// offer money projection passes through `redactFinancialFields` at the serializer layer, on
// the WHOLE body, not per field.
//
// ── HOW IT FLOORS ─────────────────────────────────────────────────────────────────────
//
// The floored keys are DELETED, not nulled and not banded: a null still tells you the key
// exists. The walk is RECURSIVE because payload shapes nest (offer totals embed line rows,
// coverage embeds candidate rows). A shallow delete would floor the envelope and leave the
// same dollars one level down.
//
// M2 note: the routes that exist at M2 (vendors, requests, settings) carry no floored money
// fields, so this is a no-op on them today. It is established now so the offers / spend /
// coverage routes in later milestones inherit it for free. `fastify.canResolve` is NEVER
// consulted here (see lib/viewer-caps.ts).

import type { ViewerCaps } from './viewer-caps.js';

/**
 * The money keys removed from a response for a caller WITHOUT bursar.spend.read_all. Kept as
 * data (not spread across route handlers) so the test asserts the list by name and a new
 * money field is covered by adding it here once.
 */
export const BURSAR_READ_ALL_FLOORED_KEYS: readonly string[] = [
  'unit_price_minor',
  'extended_minor',
  'amount_minor',
  'spend_minor',
  'total_minor',
  'total_spend_minor',
  'per_vendor_spend_minor',
  'baseline_amount_minor',
  'variance_minor',
];

const FLOORED_KEYS: ReadonlySet<string> = new Set<string>(BURSAR_READ_ALL_FLOORED_KEYS);

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

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, seen));
  }
  if (!isPlainish(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (FLOORED_KEYS.has(key)) continue;
    out[key] = walk(v, seen);
  }
  return out;
}

/**
 * THE SERIALIZER. Returns the row unchanged for a bursar.spend.read_all caller, and a deep
 * copy with every floored key REMOVED for anyone else. Call it once on the whole response
 * body, at the serializer layer.
 */
export function redactFinancialFields<T>(row: T, caps: ViewerCaps): T {
  if (caps.spend_read_all) return row;
  return walk(row, new WeakSet()) as T;
}
