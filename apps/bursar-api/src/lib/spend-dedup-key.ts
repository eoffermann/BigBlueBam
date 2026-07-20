import { createHash } from 'node:crypto';

// Spend-event dedup key (spec 6.1, M8). A PLAIN LOCAL sha256 over the canonicalized tuple
// (normalized_payee, occurred_on, amount_minor, currency, external_ref, occurrence_ordinal).
//
// WHY NOT burn's idempotency-key.ts. That derives an HMAC over a `.strict()` BurnPrecheckRequest
// keyed by INTERNAL_SERVICE_SECRET. Three reasons it is wrong here: (1) it lives in an app
// bursar-api cannot import; (2) it is typed to a charge-gate request, not a statement row; and,
// decisively, (3) keying dedup on a ROTATABLE SECRET means every already-imported row re-imports
// the day the secret rotates, because the same statement line would hash to a new key. Dedup must
// be a stable function of the row's own content and nothing else, so this is an unkeyed sha256.
//
// WHY occurrence_ordinal. Two genuine identical same-day charges (same payee, date, amount,
// currency, ref) are two real events, not one. Without the ordinal the second collapses onto the
// first and the import reports "already imported", silently UNDER-reporting spend - the mirror of
// a doubling bug and harder to notice. The ordinal is the row's index WITHIN ITS DEDUP GROUP IN
// THE SOURCE FILE, so the two charges get ordinal 0 and 1 and produce two distinct keys.

export interface SpendDedupTuple {
  normalized_payee: string | null;
  occurred_on: string; // YYYY-MM-DD
  amount_minor: number;
  currency: string;
  external_ref: string | null;
  occurrence_ordinal: number;
}

// Length-prefix each part so ('a','b') and ('ab','') can never collide regardless of what a payee
// or external_ref string contains. A raw delimiter alone is unsafe because a crafted payee could
// embed the delimiter and shift a field boundary onto another row's key (the burn-precheck-key
// lesson, applied to unkeyed hashing).
function lengthPrefixed(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((p) => {
      const s = p === null || p === undefined ? '' : String(p);
      return `${s.length}:${s}`;
    })
    .join('|');
}

/**
 * The canonical dedup key: sha256 of the length-prefixed tuple, lowercased hex (64 chars, fits
 * the varchar(64) column). Pure, deterministic, and STABLE across process runs and secret
 * rotations - the same statement row always hashes to the same key.
 */
export function spendDedupKey(t: SpendDedupTuple): string {
  const canonical = lengthPrefixed([
    (t.normalized_payee ?? '').toUpperCase(),
    t.occurred_on,
    t.amount_minor,
    (t.currency ?? '').toUpperCase(),
    t.external_ref ?? '',
    t.occurrence_ordinal,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The tuple minus the ordinal, used to bucket rows into dedup groups within one source file. */
function groupKey(t: Omit<SpendDedupTuple, 'occurrence_ordinal'>): string {
  return lengthPrefixed([
    (t.normalized_payee ?? '').toUpperCase(),
    t.occurred_on,
    t.amount_minor,
    (t.currency ?? '').toUpperCase(),
    t.external_ref ?? '',
  ]);
}

export interface SpendRowInput {
  normalized_payee: string | null;
  occurred_on: string;
  amount_minor: number;
  currency: string;
  external_ref: string | null;
}

export interface SpendRowWithKey extends SpendRowInput {
  occurrence_ordinal: number;
  dedup_key: string;
}

/**
 * Assign occurrence ordinals and dedup keys to a file's rows IN FILE ORDER. Rows sharing every
 * dedup field except ordinal are numbered 0, 1, 2, ... in the order they appear, so N genuine
 * identical charges become N distinct keys and therefore N distinct spend events. The result
 * preserves input order.
 */
export function assignOccurrenceOrdinals<T extends SpendRowInput>(
  rows: readonly T[],
): Array<T & { occurrence_ordinal: number; dedup_key: string }> {
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const gk = groupKey(row);
    const ordinal = counts.get(gk) ?? 0;
    counts.set(gk, ordinal + 1);
    return {
      ...row,
      occurrence_ordinal: ordinal,
      dedup_key: spendDedupKey({ ...row, occurrence_ordinal: ordinal }),
    };
  });
}
