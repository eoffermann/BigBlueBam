import { createHash } from 'node:crypto';

/**
 * Pure valuation, epoch, and revenue-basis math (spec 2.3.1, 2.3.2, 1.2.1). Kept dependency-free
 * and side-effect-free so the §12.1 unit suite can assert every branch against @bigbluebam/db-stubs
 * fixtures without a database or an LLM. The DB engines (attribution / revalue / rollup) call these
 * and never re-derive the arithmetic inline.
 */

export type SourceType =
  | 'bam.task'
  | 'bam.time_entry'
  | 'bill.expense'
  | 'bill.invoice_line'
  | 'helpdesk.ticket'
  | string;

export type EnvelopeBasis = 'fixed' | 'time_and_materials' | 'retainer' | 'not_to_exceed';

// ── Epochs (spec 2.3.2) ──────────────────────────────────────────────────────
// THE INVARIANT: `updated_at` is in NO epoch, and `time_logged_minutes` is in no epoch for a
// bam.task. That is what makes a task dragged across the board three times, or a time entry
// inserted against it, resolve to unchanged epochs and short-circuit at one index probe -
// zero classifications, zero LLM calls (R3-T2 / §12.1).

export interface SourceRecord {
  source_type: SourceType;
  source_id: string;
  // Identity-bearing / classifying fields. Deliberately a narrow allowlist; anything not here
  // (updated_at, time_logged_minutes on a task, position) can never enter an epoch.
  title?: string | null;
  description?: string | null;
  project_id?: string | null;
  actor_id?: string | null;
  user_id?: string | null;
  minutes?: number | null;
  occurred_at?: string | null;
  bill_rate_id?: string | null;
  burn_cost_rate_id?: string | null;
  bill_rate_updated_at?: string | null;
  cost_rate_updated_at?: string | null;
}

function h(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(parts.map((p) => (p == null ? '' : String(p))).join('')).digest('hex').slice(0, 40);
}

export interface Epochs {
  source_epoch: string;
  classification_epoch: string;
  cost_epoch: string;
  valuation_epoch: string;
}

export function computeEpochs(rec: SourceRecord): Epochs {
  const isTask = rec.source_type === 'bam.task';
  // source_epoch: identity of the source record. For a task, NOT minutes/time_logged and NEVER
  // updated_at; for a time entry the minutes ARE identity-bearing.
  const source_epoch = h([
    rec.source_type,
    rec.source_id,
    rec.title ?? '',
    rec.description ?? '',
    rec.project_id ?? '',
    isTask ? '' : (rec.minutes ?? ''),
    rec.occurred_at ?? '',
  ]);
  // classification_epoch: only fields that may change the classification target.
  const classification_epoch = h([rec.title ?? '', rec.description ?? '', rec.project_id ?? '']);
  // cost_epoch: fields affecting the dollar valuation; a change here revalues only.
  const cost_epoch = h([
    rec.user_id ?? rec.actor_id ?? '',
    rec.minutes ?? '',
    rec.bill_rate_id ?? '',
    rec.burn_cost_rate_id ?? '',
  ]);
  // valuation_epoch: hash of both rate ids + user + both rate rows' updated_at (spec work-items).
  const valuation_epoch = h([
    rec.bill_rate_id ?? '',
    rec.burn_cost_rate_id ?? '',
    rec.user_id ?? rec.actor_id ?? '',
    rec.bill_rate_updated_at ?? '',
    rec.cost_rate_updated_at ?? '',
  ]);
  return { source_epoch, classification_epoch, cost_epoch, valuation_epoch };
}

// ── Valuation (spec 2.3.1) ───────────────────────────────────────────────────

export type ValuationBasis = 'rate' | 'expense' | 'invoice' | 'none' | 'unrated' | 'no_cost_rate';
export type UnratedReason = 'no_rate_configured' | 'rate_service_unavailable' | 'currency_mismatch';

export interface ValuationInput {
  source_type: SourceType;
  minutes?: number | null;
  // Resolved per-hour minor-unit rates (null = unresolved).
  bill_rate_minor_per_hour?: number | null;
  cost_rate_minor_per_hour?: number | null;
  // For an expense line.
  expense_amount_minor?: number | null;
  expense_billable?: boolean | null;
  expense_status?: string | null; // 'rejected' voids
  // For an invoice line that restates nothing already ingested.
  invoice_line_amount_minor?: number | null;
  invoice_line_has_time_entries?: boolean;
  invoice_line_has_linked_expense?: boolean;
  bill_currency?: string | null;
  cost_currency?: string | null;
  // Whether the row has ever been valued (drives fail-safe unrated write in revalue).
  already_valued?: boolean;
  rate_service_available?: boolean;
}

export interface Valuation {
  billable_amount: number | null;
  cost_amount: number | null;
  valuation_basis: ValuationBasis;
  unrated_reason: UnratedReason | null;
  // False when the line must be excluded from envelope consumption (non-billable / voided).
  counts_toward_consumption: boolean;
  excluded: boolean;
  exclusion_reason: string | null;
}

const ZERO_VAL: Valuation = {
  billable_amount: null,
  cost_amount: null,
  valuation_basis: 'none',
  unrated_reason: null,
  counts_toward_consumption: false,
  excluded: false,
  exclusion_reason: null,
};

/**
 * Value one work item, billable and cost separately (spec 2.3.1). Deterministic and total: every
 * branch returns a Valuation, so a caller never has to guess the "unrated vs zero" question.
 */
export function valueWorkItem(input: ValuationInput): Valuation {
  const st = input.source_type;

  // A bam.task work item always has valuation_basis='none' and no money. time_logged_minutes
  // is invisible here (R2-D1), so logging 60 minutes against a task produces exactly ONE priced
  // work item (the time_entry), not two.
  if (st === 'bam.task') {
    return { ...ZERO_VAL, valuation_basis: 'none' };
  }

  // A voided/rejected expense excludes and reverses (R2-D5).
  if (st === 'bill.expense' && input.expense_status === 'rejected') {
    return { ...ZERO_VAL, excluded: true, exclusion_reason: 'source_voided' };
  }

  if (st === 'bill.expense') {
    const amt = input.expense_amount_minor ?? 0;
    // billable=false contributes to cost_amount and NOT to envelope consumption (R2-D5).
    if (input.expense_billable === false) {
      return {
        billable_amount: null,
        cost_amount: amt,
        valuation_basis: 'expense',
        unrated_reason: null,
        counts_toward_consumption: false,
        excluded: false,
        exclusion_reason: null,
      };
    }
    return {
      billable_amount: amt,
      cost_amount: amt,
      valuation_basis: 'expense',
      unrated_reason: null,
      counts_toward_consumption: true,
      excluded: false,
      exclusion_reason: null,
    };
  }

  // An invoice prices NOTHING that restates already-ingested work (spec 2.3.1.1): only a line
  // with no time_entry_ids and no linked expense prices as valuation_basis='invoice'.
  if (st === 'bill.invoice_line') {
    if (input.invoice_line_has_time_entries || input.invoice_line_has_linked_expense) {
      return { ...ZERO_VAL, excluded: true, exclusion_reason: 'superseded_epoch' };
    }
    const amt = input.invoice_line_amount_minor ?? 0;
    return {
      billable_amount: amt,
      cost_amount: null,
      valuation_basis: 'invoice',
      unrated_reason: null,
      counts_toward_consumption: true,
      excluded: false,
      exclusion_reason: null,
    };
  }

  // Rate-priced (bam.time_entry and anything hour-based).
  const minutes = input.minutes ?? 0;
  const hours = minutes / 60;

  // Currency mismatch is unratable rather than silently converted.
  if (
    input.bill_rate_minor_per_hour != null &&
    input.cost_rate_minor_per_hour != null &&
    input.bill_currency &&
    input.cost_currency &&
    input.bill_currency !== input.cost_currency
  ) {
    return firstOrSafeUnrated(input, 'currency_mismatch');
  }

  if (input.bill_rate_minor_per_hour == null) {
    // No billable rate resolved. Distinguish "service down" from "none configured" (R2-I5).
    const reason: UnratedReason =
      input.rate_service_available === false ? 'rate_service_unavailable' : 'no_rate_configured';
    return firstOrSafeUnrated(input, reason);
  }

  const billable = Math.round(input.bill_rate_minor_per_hour * hours);
  const cost =
    input.cost_rate_minor_per_hour != null
      ? Math.round(input.cost_rate_minor_per_hour * hours)
      : null;
  return {
    billable_amount: billable,
    cost_amount: cost,
    // no_cost_rate marks a billable-but-costless row so cost-rate-coverage can be measured.
    valuation_basis: cost == null ? 'no_cost_rate' : 'rate',
    unrated_reason: null,
    counts_toward_consumption: true,
    excluded: false,
    exclusion_reason: null,
  };
}

/**
 * The unrated arm. On a FIRST valuation (never successfully valued) it writes `unrated` with the
 * reason; on an ALREADY-valued row it is fail-safe and leaves the existing dollars in place -
 * the caller enforces "unrated only where valued_at IS NULL" (spec 4.5, R3-T3).
 */
function firstOrSafeUnrated(input: ValuationInput, reason: UnratedReason): Valuation {
  if (input.already_valued) {
    // Signal the caller to leave the row untouched.
    return { ...ZERO_VAL, valuation_basis: 'rate', counts_toward_consumption: true };
  }
  return {
    billable_amount: null,
    cost_amount: null,
    valuation_basis: 'unrated',
    unrated_reason: reason,
    counts_toward_consumption: false,
    excluded: false,
    exclusion_reason: null,
  };
}

// ── Revenue basis (spec 1.2.1) ───────────────────────────────────────────────
// The branch is load-bearing: an unbranched "billable - cost" formula moves the WRONG way on a
// fixed-fee SOW (delivering under budget shows less margin).

export type RevenueBasisKind =
  | 'contract_value'
  | 'billable_recognized_capped'
  | 'contract_value_per_period'
  | 'billable_recognized';

export function revenueBasisFor(envelope: EnvelopeBasis): RevenueBasisKind {
  switch (envelope) {
    case 'fixed':
      return 'contract_value';
    case 'not_to_exceed':
      return 'billable_recognized_capped';
    case 'retainer':
      return 'contract_value_per_period';
    case 'time_and_materials':
      return 'billable_recognized';
    default:
      return 'billable_recognized';
  }
}

export interface RevenueInput {
  envelope_basis: EnvelopeBasis;
  contract_value: number | null; // whole chain value (or per-period value for retainer)
  attributed_billable: number; // recognized billable to date
  cap_amount?: number | null; // NTE ceiling
}

/**
 * Recognized revenue for the chain under its basis. NTE recognizes actual work up to the cap,
 * NEVER the cap itself: min(billable, cap) (R3-D1), which is what keeps it from booking revenue
 * that can never be invoiced.
 */
export function recognizedRevenue(input: RevenueInput): number {
  switch (input.envelope_basis) {
    case 'fixed':
      return input.contract_value ?? 0;
    case 'retainer':
      return input.contract_value ?? 0; // per-period value
    case 'not_to_exceed': {
      const cap = input.cap_amount ?? input.contract_value ?? Number.MAX_SAFE_INTEGER;
      return Math.min(input.attributed_billable, cap);
    }
    case 'time_and_materials':
    default:
      return input.attributed_billable;
  }
}

export function marginFrom(revenue: number, attributedCost: number | null): number | null {
  if (attributedCost == null) return null;
  return revenue - attributedCost;
}
