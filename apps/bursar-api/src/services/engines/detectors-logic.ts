/**
 * Post-award drift detectors, as PURE functions (spec 7.3, 8). No db/env import so the M8 unit
 * suite proves the classification against fixtures. The DB claim loop, org sweep, and finding
 * upsert live in drift.engine.ts / drift.store.ts.
 *
 * Four detectors:
 *   price_drift        - a matched invoiced line whose amount deviates from the frozen baseline,
 *                        SAME CURRENCY, by >= price_drift_threshold_pct AND >= min absolute.
 *   scope_divergence   - an invoiced line under an awarded vendor with no baseline item (paying
 *                        for unbaselined scope), or a SILENT baseline item (basis stated).
 *   unbaselined_vendor - recurring spend (>= 2 events in 180d) with NO award, grouped by
 *                        normalized_payee (the shadow-IT bucket; the bucket IS the product).
 *   renewal_cliff      - the renewal radar (see the band helpers below), driven separately.
 *
 * Two invariants run through all of it:
 *   - CURRENCY IS A HARD PRECONDITION. Price drift is computed only on currency equality; a
 *     mismatch records `currency_mismatch` and skips, because otherwise an FX move reads as
 *     double-digit price drift.
 *   - DOLLARS AT STAKE ARE COMPUTED, NEVER ESTIMATED. When a figure cannot be computed the finding
 *     stores NULL and the UI shows "not quantified".
 */

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface SpendLine {
  id: string;
  normalized_payee: string | null;
  vendor_id: string | null;
  occurred_on: string; // YYYY-MM-DD
  amount_minor: number;
  currency: string;
}

export interface BaselineLine {
  id: string;
  award_id: string;
  title: string;
  kind: string; // included | excluded_at_award | absent_at_award
  currency: string | null;
  unit_price_minor: number | null;
  quantity: string | number | null;
  extended_minor: number | null;
}

export interface AwardTerm {
  id: string;
  term_start: string | null; // YYYY-MM-DD
  term_end: string | null;
  awarded_at: string; // ISO
  currency: string;
}

export const DEFAULT_PRICE_DRIFT_THRESHOLD_PCT = 10;
export const PRICE_DRIFT_MIN_ABSOLUTE_MINOR = 2500; // $25.00
export const UNBASELINED_WINDOW_DAYS = 180;
export const OPEN_ENDED_SILENT_WINDOW_DAYS = 365;

/* ------------------------------------------------------------------ */
/*  Award selection (spec 7.3 point 2), including null terms          */
/* ------------------------------------------------------------------ */

export type AwardMatchMethod = 'exact' | 'fuzzy';

export interface AwardSelection {
  award: AwardTerm;
  match_method: AwardMatchMethod;
}

/**
 * Select the award a spend event falls under. A BOUNDED award (non-null term_end) wins when
 * term_start <= occurred_on <= term_end. Only when NO bounded award matches is an OPEN-ENDED award
 * (null term_end) selected - when occurred_on >= term_start, or unconditionally when both terms are
 * null. Ambiguity (more than one candidate) picks the most recent and records match_method='fuzzy';
 * a single candidate is 'exact'.
 */
export function selectAwardForSpend(awards: readonly AwardTerm[], occurredOn: string): AwardSelection | null {
  const inBounded = (a: AwardTerm) =>
    a.term_end !== null && (a.term_start === null || a.term_start <= occurredOn) && a.term_end >= occurredOn;
  const inOpen = (a: AwardTerm) => a.term_end === null && (a.term_start === null || a.term_start <= occurredOn);

  let candidates = awards.filter(inBounded);
  if (candidates.length === 0) candidates = awards.filter(inOpen);
  if (candidates.length === 0) return null;

  // Most recent first: by term_start desc (nulls last), then awarded_at desc.
  const sorted = [...candidates].sort((a, b) => {
    const ta = a.term_start ?? '';
    const tb = b.term_start ?? '';
    if (ta !== tb) return tb.localeCompare(ta);
    return b.awarded_at.localeCompare(a.awarded_at);
  });
  return { award: sorted[0]!, match_method: candidates.length > 1 ? 'fuzzy' : 'exact' };
}

/* ------------------------------------------------------------------ */
/*  Deterministic line matching (spec 7.3 point 3), NO LLM            */
/* ------------------------------------------------------------------ */

import { normalizePayee, trigramSimilarity } from '../../lib/payee-normalize.js';

export const LINE_MATCH_TRIGRAM_FLOOR = 0.5;
export const UNIT_PRICE_TOLERANCE_PCT = 1; // "unit-price equality within tolerance"

export type LineMatchMethod = 'exact' | 'trigram' | 'unit_price' | 'none';

export interface LineMatch {
  baseline: BaselineLine;
  method: LineMatchMethod;
  score: number;
}

/**
 * Match a spend line to at most one INCLUDED baseline item, deterministically and in order:
 *   1. exact (case-folded) description equality against the baseline title,
 *   2. trigram over the baseline title above the floor,
 *   3. unit-price equality within tolerance (the amount matches a baseline line's expected amount).
 * There is NO LLM matcher. Returns method 'none' when nothing matches.
 */
export function matchSpendLine(
  spend: Pick<SpendLine, 'normalized_payee' | 'amount_minor' | 'currency'>,
  descriptor: string | null,
  baselineItems: readonly BaselineLine[],
): LineMatch | null {
  const included = baselineItems.filter((b) => b.kind === 'included');
  if (included.length === 0) return null;
  const desc = normalizePayee(descriptor ?? spend.normalized_payee ?? '');

  // 1. exact title
  const exact = included.find((b) => normalizePayee(b.title) === desc && desc.length > 0);
  if (exact) return { baseline: exact, method: 'exact', score: 1 };

  // 2. trigram over title
  let best: { b: BaselineLine; score: number } | null = null;
  for (const b of included) {
    const score = trigramSimilarity(desc, normalizePayee(b.title));
    if (!best || score > best.score) best = { b, score };
  }
  if (best && best.score >= LINE_MATCH_TRIGRAM_FLOOR) {
    return { baseline: best.b, method: 'trigram', score: best.score };
  }

  // 3. unit-price equality within tolerance, same currency
  for (const b of included) {
    const expected = expectedAmountMinor(b);
    if (expected === null || expected === 0) continue;
    if (b.currency && b.currency !== spend.currency) continue;
    const diffPct = Math.abs((spend.amount_minor - expected) / expected) * 100;
    if (diffPct <= UNIT_PRICE_TOLERANCE_PCT) {
      return { baseline: b, method: 'unit_price', score: 1 - diffPct / 100 };
    }
  }
  return null;
}

/** The baseline item's expected charge in minor units: extended when present, else unit price. */
export function expectedAmountMinor(b: BaselineLine): number | null {
  if (b.extended_minor !== null && b.extended_minor !== undefined) return b.extended_minor;
  if (b.unit_price_minor !== null && b.unit_price_minor !== undefined) return b.unit_price_minor;
  return null;
}

/* ------------------------------------------------------------------ */
/*  Detector 1: price_drift                                           */
/* ------------------------------------------------------------------ */

export type PriceDriftOutcome =
  | { result: 'skip'; reason: 'currency_mismatch'; observed_currency: string; baseline_currency: string }
  | { result: 'no_drift' }
  | {
      result: 'drift';
      metric: 'unit_price';
      observed_minor: number;
      expected_minor: number;
      deviation_pct: number;
      dollars_at_stake_minor: number;
      currency: string;
    };

/**
 * Detect price drift for a spend line already matched to an INCLUDED baseline item. The currency
 * guard is a hard precondition: a currency mismatch returns `skip` with reason `currency_mismatch`
 * and NO drift is computed. Drift fires only when the deviation is both >= threshold_pct AND the
 * absolute difference is >= the minimum. dollars_at_stake is the computed overage (observed -
 * expected); it is never estimated.
 */
export function evaluatePriceDrift(
  spend: Pick<SpendLine, 'amount_minor' | 'currency'>,
  baseline: BaselineLine,
  thresholdPct: number = DEFAULT_PRICE_DRIFT_THRESHOLD_PCT,
  minAbsoluteMinor: number = PRICE_DRIFT_MIN_ABSOLUTE_MINOR,
): PriceDriftOutcome {
  const baselineCurrency = baseline.currency ?? spend.currency;
  if (baselineCurrency !== spend.currency) {
    return {
      result: 'skip',
      reason: 'currency_mismatch',
      observed_currency: spend.currency,
      baseline_currency: baselineCurrency,
    };
  }
  const expected = expectedAmountMinor(baseline);
  if (expected === null || expected === 0) return { result: 'no_drift' };
  const diff = spend.amount_minor - expected;
  const deviationPct = (diff / expected) * 100;
  if (Math.abs(deviationPct) >= thresholdPct && Math.abs(diff) >= minAbsoluteMinor) {
    return {
      result: 'drift',
      metric: 'unit_price',
      observed_minor: spend.amount_minor,
      expected_minor: expected,
      deviation_pct: Math.round(deviationPct * 100) / 100,
      dollars_at_stake_minor: diff,
      currency: spend.currency,
    };
  }
  return { result: 'no_drift' };
}

/* ------------------------------------------------------------------ */
/*  Detector 2: scope_divergence                                      */
/* ------------------------------------------------------------------ */

export type ScopeDivergenceKind = 'invoiced_unbaselined' | 'silent_line';

export interface ScopeDivergenceFinding {
  kind: ScopeDivergenceKind;
  // For invoiced_unbaselined this is the spend amount (computed); for silent_line it is null
  // (unquantifiable - we cannot price the absence of a charge). The basis is stated on silent lines.
  dollars_at_stake_minor: number | null;
  currency: string | null;
  basis: string | null;
}

/**
 * An invoiced line under an awarded vendor that matches NO baseline item is scope divergence: you
 * are paying for scope that was not in the frozen baseline. dollars_at_stake is the spend amount
 * (computed). Call this ONLY after matchSpendLine has returned null for a spend line whose vendor
 * has an active award.
 */
export function invoicedScopeDivergence(spend: Pick<SpendLine, 'amount_minor' | 'currency'>): ScopeDivergenceFinding {
  return {
    kind: 'invoiced_unbaselined',
    dollars_at_stake_minor: spend.amount_minor,
    currency: spend.currency,
    basis: null,
  };
}

/**
 * A SILENT baseline item: an included baseline item with no matching spend across the evaluation
 * window (spec 7.3). The basis states which window was used: an elapsed bounded term, or a rolling
 * window for an open-ended award. dollars_at_stake is NULL (unquantifiable - the finding is "you
 * are not receiving / being billed for something you baselined", which has no computed dollar
 * figure). Returns null when the award's window is not yet evaluable (a bounded term_end that has
 * not elapsed).
 */
export function silentLineDivergence(
  baseline: BaselineLine,
  award: AwardTerm,
  today: string,
): ScopeDivergenceFinding | null {
  let basis: string | null = null;
  if (award.term_end !== null) {
    // Bounded award: only evaluate once the term has elapsed.
    if (award.term_end >= today) return null;
    basis = 'elapsed_term';
  } else {
    // Open-ended award: a rolling window.
    basis = 'rolling_12mo';
  }
  return { kind: 'silent_line', dollars_at_stake_minor: null, currency: baseline.currency, basis };
}

/* ------------------------------------------------------------------ */
/*  Detector 3: unbaselined_vendor (the shadow-IT bucket)             */
/* ------------------------------------------------------------------ */

export interface UnbaselinedVendorFinding {
  normalized_payee: string;
  event_count: number;
  dollars_at_stake_minor: number;
  currency: string | null;
  first_occurred_on: string;
  last_occurred_on: string;
}

/**
 * Group spend with NO award by normalized_payee and flag any payee with >= 2 events inside the
 * trailing window (default 180d ending at `today`). Grouping is by normalized_payee, NOT vendor_id,
 * because unmatched spend keeps vendor_id NULL - a vendor_id grouping would fire on nothing. This
 * is the shadow-IT bucket; the bucket is the product. dollars_at_stake is the summed spend in the
 * window (computed). Events must all be for payees WITH NO active award (the caller filters that).
 */
export function detectUnbaselinedVendors(
  events: readonly SpendLine[],
  today: string,
  windowDays: number = UNBASELINED_WINDOW_DAYS,
  minEvents = 2,
): UnbaselinedVendorFinding[] {
  const windowStart = addDays(today, -windowDays);
  const byPayee = new Map<string, SpendLine[]>();
  for (const e of events) {
    if (e.occurred_on < windowStart || e.occurred_on > today) continue;
    const payee = (e.normalized_payee ?? '').trim();
    if (!payee) continue;
    const list = byPayee.get(payee) ?? [];
    list.push(e);
    byPayee.set(payee, list);
  }
  const findings: UnbaselinedVendorFinding[] = [];
  for (const [payee, list] of byPayee) {
    if (list.length < minEvents) continue;
    const dates = list.map((e) => e.occurred_on).sort();
    findings.push({
      normalized_payee: payee,
      event_count: list.length,
      dollars_at_stake_minor: list.reduce((s, e) => s + e.amount_minor, 0),
      currency: list[0]!.currency ?? null,
      first_occurred_on: dates[0]!,
      last_occurred_on: dates[dates.length - 1]!,
    });
  }
  // Deterministic order for stable dedup keys / tests.
  findings.sort((a, b) => a.normalized_payee.localeCompare(b.normalized_payee));
  return findings;
}

/* ------------------------------------------------------------------ */
/*  Detector 4: renewal_cliff bands (spec 8)                          */
/* ------------------------------------------------------------------ */

export const RENEWAL_BANDS = [
  { band: 't_minus_90', days: 90 },
  { band: 't_minus_60', days: 60 },
  { band: 't_minus_30', days: 30 },
  { band: 't_minus_7', days: 7 },
] as const;

export type RenewalBand = (typeof RENEWAL_BANDS)[number]['band'];

/**
 * The tightest lead band a notice deadline currently sits inside, or null when the deadline is
 * more than 90 days out (or already past). `t_minus_7` is the most urgent.
 */
export function currentRenewalBand(noticeDeadline: string, today: string): RenewalBand | null {
  const daysOut = daysBetween(today, noticeDeadline);
  if (daysOut < 0) return null; // already past the notice deadline
  let match: RenewalBand | null = null;
  for (const b of RENEWAL_BANDS) {
    if (daysOut <= b.days) match = b.band; // keep tightening
  }
  return match;
}

/**
 * The bands that must fire now: every band at or tighter than the current band that is not already
 * in alerted_bands (spec 8 idempotency). Returns them tightest-last so the caller records them in
 * order. An empty array means nothing new to alert.
 */
export function bandsToAlert(currentBand: RenewalBand | null, alertedBands: readonly string[]): RenewalBand[] {
  if (!currentBand) return [];
  const idx = RENEWAL_BANDS.findIndex((b) => b.band === currentBand);
  const due = RENEWAL_BANDS.slice(0, idx + 1).map((b) => b.band);
  return due.filter((b) => !alertedBands.includes(b));
}

/* ------------------------------------------------------------------ */
/*  Date helpers (UTC, YYYY-MM-DD in / out)                           */
/* ------------------------------------------------------------------ */

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
