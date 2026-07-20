// Bursar's OWN payee normalization + fuzzy candidate resolution (spec 6.1, milestone M2).
//
// Braid is deliberately NOT used for payee strings: braid.ts constrains source_type to a
// five-value enum with a uuid source_id (a raw payee string fails Zod), and the Braid resolver
// mints a fresh singleton profile per unseen pair, so every card string would get its own
// golden profile - the opposite of dedup. Bursar resolves payees against bursar_vendors /
// bursar_payee_aliases with its own trigram matcher. Braid is called only for the
// bond_company_id -> golden id hop (see braid-resolve.client.ts).
//
// The pipeline is intentionally deterministic and side-effect-free so it is unit-testable
// without a DB. The DB's pg_trgm GIN index does the real candidate lookup at scale; this
// module supplies the normalization the index is built on, and a JS similarity that mirrors
// pg_trgm.similarity closely enough for the resolution decision and tests.

/* ------------------------------------------------------------------ */
/*  Normalization                                                     */
/* ------------------------------------------------------------------ */

// Card-network / processor prefixes that ride in front of a merchant name on statement rows.
// Longest-first so `SQ *` is stripped before a bare `*`. These are anchored to the START of
// the string after uppercasing.
const CARD_PREFIXES = [
  'SQ *',
  'SQ*',
  'TST*',
  'TST* ',
  'SP *',
  'SP*',
  'PAYPAL *',
  'PAYPAL*',
  'PP*',
  'PP *',
  'POS ',
  'PURCHASE ',
  'DEBIT ',
  'CHECKCARD ',
  'VISA ',
];

// Corporate suffixes stripped from the END. Uppercase, no trailing punctuation (punctuation is
// removed before this runs).
const CORP_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'L L C',
  'LLP',
  'LP',
  'LTD',
  'LIMITED',
  'CO',
  'CORP',
  'CORPORATION',
  'COMPANY',
  'PLC',
  'GMBH',
  'AG',
  'SA',
  'SAS',
  'BV',
  'PTY',
  'PVT',
  'PC',
  'PA',
]);

// Two-letter US state codes, stripped when they trail the name (a statement city/state tail).
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** Strip a leading card-network / processor prefix. Repeats until none remains. */
function stripCardNoise(s: string): string {
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of CARD_PREFIXES) {
      if (out.startsWith(p)) {
        out = out.slice(p.length);
        changed = true;
        break;
      }
    }
    // A bare leading `*` (some processors prepend just an asterisk).
    if (out.startsWith('*')) {
      out = out.slice(1);
      changed = true;
    }
  }
  return out;
}

/**
 * Strip a trailing phone number and/or `CITY ST` location tail. A statement row commonly ends
 * `... 800-555-1234` or `... SEATTLE WA`. Conservative: only strips a state code when it is the
 * final token and preceded by at least one other token (so a two-letter company name is safe).
 */
function stripTrailingLocationAndPhone(s: string): string {
  let out = s;
  // Trailing phone: 7-15 digits possibly separated by spaces/dashes/dots/parens.
  out = out.replace(/[-.\s(]*\+?\d[\d\s().-]{5,}\d\)?\s*$/g, ' ').trimEnd();
  const tokens = out.split(' ').filter(Boolean);
  // Trailing state code preceded by something (the city may be the token before it; we only
  // remove the state code, leaving the city, which keeps normalization conservative).
  const lastTok = tokens[tokens.length - 1];
  if (tokens.length >= 2 && lastTok && US_STATES.has(lastTok)) {
    tokens.pop();
  }
  return tokens.join(' ');
}

/** Strip one or more trailing corporate suffix tokens. */
function stripCorporateSuffixes(s: string): string {
  const tokens = s.split(' ').filter(Boolean);
  let last = tokens[tokens.length - 1];
  while (tokens.length > 1 && last && CORP_SUFFIXES.has(last)) {
    tokens.pop();
    last = tokens[tokens.length - 1];
  }
  return tokens.join(' ');
}

/**
 * Normalize a raw payee string to its canonical form. Pure. The steps, in order:
 *   1. uppercase-fold + trim
 *   2. strip leading card noise (`*`, `SQ *`, `TST*`, ...)
 *   3. drop punctuation to spaces (keep alphanumerics and spaces)
 *   4. strip trailing phone and `CITY ST` tail
 *   5. strip trailing corporate suffixes (INC / LLC / LTD / ...)
 *   6. collapse whitespace
 */
export function normalizePayee(raw: string): string {
  if (!raw) return '';
  let s = raw.toUpperCase().trim();
  s = stripCardNoise(s);
  // Replace any non-alphanumeric with a space BEFORE the location/suffix passes so that
  // `ACME, INC.` and `ACME  INC` both reduce to token boundaries.
  s = s.replace(/[^A-Z0-9]+/g, ' ').trim();
  s = s.replace(/\s+/g, ' ');
  s = stripTrailingLocationAndPhone(s);
  s = stripCorporateSuffixes(s);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/* ------------------------------------------------------------------ */
/*  Trigram similarity (pg_trgm-compatible)                           */
/* ------------------------------------------------------------------ */

// pg_trgm pads each alphanumeric word with two leading spaces and one trailing space, lower-
// cases, then takes the set of 3-grams. similarity(a,b) = |A ∩ B| / |A ∪ B|.

function trigrams(input: string): Set<string> {
  const grams = new Set<string>();
  const words = input.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i < padded.length - 2; i++) {
      grams.add(padded.slice(i, i + 3));
    }
  }
  return grams;
}

/** pg_trgm-style similarity in [0, 1]. Two empty strings are similarity 1 by convention here
 *  is avoided: an empty side yields 0 so a blank payee never auto-matches. */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* ------------------------------------------------------------------ */
/*  Resolution decision                                               */
/* ------------------------------------------------------------------ */

export type PayeeMatchDisposition = 'auto_accept' | 'needs_review' | 'no_match';

export interface PayeeMatchThresholds {
  /** Candidate floor. Below this a match is not even proposed (spec: 0.45 default). */
  match: number;
  /** Auto-accept floor. At or above this a link is written source='auto' (spec: 0.65). */
  autoAccept: number;
}

export const DEFAULT_PAYEE_THRESHOLDS: PayeeMatchThresholds = { match: 0.45, autoAccept: 0.65 };

/**
 * Classify a similarity score against the thresholds. The band BETWEEN match and autoAccept is
 * a HUMAN REVIEW item, never a silent join (spec 6.1): it is written as a bursar_payee_aliases
 * row with resolved_by pending, not auto-linked. Below `match` there is no candidate at all and
 * the spend keeps vendor_id NULL.
 */
export function classifyPayeeMatch(
  score: number,
  thresholds: PayeeMatchThresholds = DEFAULT_PAYEE_THRESHOLDS,
): PayeeMatchDisposition {
  if (score >= thresholds.autoAccept) return 'auto_accept';
  if (score >= thresholds.match) return 'needs_review';
  return 'no_match';
}

export interface VendorCandidate {
  vendor_id: string;
  normalized_name: string;
}

export interface PayeeResolution {
  normalized_payee: string;
  disposition: PayeeMatchDisposition;
  /** The best candidate vendor, present for auto_accept and needs_review; null for no_match. */
  vendor_id: string | null;
  score: number;
}

/**
 * Resolve a raw payee against a set of candidate vendors (already fetched, e.g. via the DB
 * trigram index). Picks the single best candidate and classifies it. This is the decision the
 * ingest path makes; a needs_review disposition MUST be persisted as a pending alias, and a
 * no_match MUST leave the spend event's vendor_id NULL.
 */
export function resolvePayee(
  raw: string,
  candidates: VendorCandidate[],
  thresholds: PayeeMatchThresholds = DEFAULT_PAYEE_THRESHOLDS,
): PayeeResolution {
  const normalized = normalizePayee(raw);
  let best: { vendor_id: string; score: number } | null = null;
  for (const c of candidates) {
    const score = trigramSimilarity(normalized, c.normalized_name);
    if (!best || score > best.score) best = { vendor_id: c.vendor_id, score };
  }
  if (!best) {
    return { normalized_payee: normalized, disposition: 'no_match', vendor_id: null, score: 0 };
  }
  const disposition = classifyPayeeMatch(best.score, thresholds);
  return {
    normalized_payee: normalized,
    disposition,
    vendor_id: disposition === 'no_match' ? null : best.vendor_id,
    score: best.score,
  };
}
