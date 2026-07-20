// The bid-confidentiality SEAL predicate, in the shared read/repository layer (spec 5.6).
//
// "The seal is a predicate in the shared query/repository layer that every read of offers,
// lines, coverage, and totals passes through - not endpoint-by-endpoint." Round 2 enumerated
// endpoints and then added two CSV exports and four MCP read tools that bypassed the seal,
// reopening the finding at new surfaces. A shared predicate cannot be forgotten by a new
// route.
//
// M2 establishes the layer. The offer / line / coverage / totals routes land in later
// milestones and MUST project their reads through `applySeal` rather than re-implementing
// the sealed_until check per handler. The offer-read tables do not exist yet, so this file
// is deliberately generic over "a row that may carry sealed content".

/** A row that may be under seal until `sealed_until`. Offers carry this; lines/coverage/
 *  totals inherit their offer's seal, resolved by the caller passing the offer's timestamp. */
export interface Sealable {
  sealed_until?: string | Date | null;
}

/**
 * True when the offer's rival-bid content is STILL sealed at `now`. A null / absent
 * `sealed_until` is never sealed (an offer with no seal window is open).
 *
 * The one place the sealed_until comparison is made. Do not inline `sealed_until > now`
 * anywhere else.
 */
export function isSealed(row: Sealable, now: Date = new Date()): boolean {
  const until = row.sealed_until;
  if (until === undefined || until === null) return false;
  const untilMs = until instanceof Date ? until.getTime() : new Date(until).getTime();
  if (Number.isNaN(untilMs)) return false;
  return untilMs > now.getTime();
}

/**
 * The set of keys that carry a rival's competitive content and are withheld while sealed.
 * Kept as data so the seal cannot be forgotten by a new field: a later milestone adds a
 * sealed field by naming it here once. `sealed` callers receive these keys removed and a
 * `withheld_reason` marker instead.
 */
export const BURSAR_SEALED_CONTENT_KEYS: readonly string[] = [
  'unit_price_minor',
  'extended_minor',
  'total_minor',
  'raw_text',
  'cited_span',
  'lines',
  'coverage',
  'totals',
];

const SEALED_KEYS: ReadonlySet<string> = new Set<string>(BURSAR_SEALED_CONTENT_KEYS);

function isPlainish(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/**
 * Project a sealable offer-shaped row for a viewer, given whether the seal is in force. When
 * sealed, the competitive-content keys are REMOVED (not nulled) and a `withheld_reason` is
 * added. When open, the row is returned unchanged. Recursive so nested line/coverage arrays
 * are covered.
 *
 * The `sealed` decision is passed in (resolved from `isSealed` plus the unseal grant) so this
 * function stays pure and the same predicate governs every surface.
 */
export function applySeal<T>(row: T, sealed: boolean): T {
  if (!sealed) return row;
  return walkSeal(row, new WeakSet()) as T;
}

function walkSeal(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((v) => walkSeal(v, seen));
  if (!isPlainish(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  let withheld = false;
  for (const [key, v] of Object.entries(value)) {
    if (SEALED_KEYS.has(key)) {
      withheld = true;
      continue;
    }
    out[key] = walkSeal(v, seen);
  }
  if (withheld && out.withheld_reason === undefined) out.withheld_reason = 'sealed';
  return out;
}
