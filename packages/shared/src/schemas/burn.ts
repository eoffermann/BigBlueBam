import { z } from 'zod';

// Burn (AI margin / envelope-attribution monitor) schemas.
//
// This module OWNS the Burn engagement, deliverable, work-item, attribution, rule,
// precheck, variance, cost-rate, rollup and org-settings shapes shared between burn-api,
// the /burn SPA, and the burn_* MCP tools, plus the authoritative JSONB shapes
// (cited_span, rule match, variance detail).
//
// See docs/brainstorming/2026_07_19_08_01_APP_DESIGN_burn.md sections 1.2, 2.4, 3.1, 3.3
// and 6.1.
//
// THE ONE THING TO READ BEFORE EDITING: BurnMoneyBlock is a DISCRIMINATED UNION on
// `metric_basis` with three members (section 1.2.2). Do not "simplify" it into one object
// with optional fields. See the long comment above it.

/* ------------------------------------------------------------------ */
/*  Enums                                                             */
/* ------------------------------------------------------------------ */

// Drives revenue_basis, and the margin formula branches on it (section 1.2.1). An
// unbranched formula measures, on a fixed-fee SOW, "the T&M invoice we did not send, minus
// cost", which moves the WRONG WAY.
export const BurnEnvelopeBasis = z.enum([
  'fixed',
  'time_and_materials',
  'retainer',
  'not_to_exceed',
]);
export type BurnEnvelopeBasis = z.infer<typeof BurnEnvelopeBasis>;

// not_to_exceed is DELIBERATELY not grouped with fixed: NTE bills actual work up to a
// ceiling and never the ceiling itself (round-3 blocker R3-D1).
export const BurnRevenueBasis = z.enum([
  'contract_value',
  'billable_recognized_capped',
  'contract_value_per_period',
  'billable_recognized',
]);
export type BurnRevenueBasis = z.infer<typeof BurnRevenueBasis>;

// The RESPONSE discriminator. `suppressed` is a response shape only and is never stored;
// burn_engagement_rollups.metric_basis only ever holds the first two.
export const BurnMetricBasis = z.enum(['true_margin', 'contract_consumption', 'suppressed']);
export type BurnMetricBasis = z.infer<typeof BurnMetricBasis>;

export const BurnStoredMetricBasis = z.enum(['true_margin', 'contract_consumption']);
export type BurnStoredMetricBasis = z.infer<typeof BurnStoredMetricBasis>;

// Why the cost-bearing fields are absent rather than banded (section 2.4 point 17).
//   insufficient_permission  the caller does not hold burn.financials.read_all
//   insufficient_contributors the chain is below min_contributors_for_cost_aggregate
//   unresolved_viewer        the dual-read resolver could not resolve the caller, or an
//                            asker_user_id could not be resolved (fail closed)
export const BurnSuppressedReason = z.enum([
  'insufficient_permission',
  'insufficient_contributors',
  'unresolved_viewer',
]);
export type BurnSuppressedReason = z.infer<typeof BurnSuppressedReason>;

export const BurnMarginState = z.enum(['in_progress', 'final']);
export type BurnMarginState = z.infer<typeof BurnMarginState>;

export const BurnEngagementKind = z.enum([
  'sow',
  'proposal',
  'engagement_letter',
  'msa',
  'retainer',
  'amendment',
  'change_order',
  'other',
]);
export type BurnEngagementKind = z.infer<typeof BurnEngagementKind>;

export const BurnEngagementStatus = z.enum([
  'draft',
  'extracting',
  'active',
  'superseded',
  'closed',
]);
export type BurnEngagementStatus = z.infer<typeof BurnEngagementStatus>;

export const BurnExtractionStatus = z.enum([
  'pending',
  'running',
  'extracted',
  'partial',
  'failed',
  'rejected_limits',
  'not_applicable',
]);
export type BurnExtractionStatus = z.infer<typeof BurnExtractionStatus>;

export const BurnDeliverableKind = z.enum([
  'work_product',
  'milestone',
  'recurring_service',
  'support',
  'expense_allowance',
  'other',
]);
export type BurnDeliverableKind = z.infer<typeof BurnDeliverableKind>;

// 'even_split' is deliberately deleted (round-2 R2-D6): the bulk fast path confirms
// deliverables as `unpriced`, never as an even split of the contract value.
export const BurnEnvelopeSource = z.enum(['proposed', 'human', 'stated', 'unpriced']);
export type BurnEnvelopeSource = z.infer<typeof BurnEnvelopeSource>;

// 'closed' is what makes verdict_reason='deliverable_closed' reachable at all.
export const BurnLifecycleStatus = z.enum(['open', 'complete', 'closed']);
export type BurnLifecycleStatus = z.infer<typeof BurnLifecycleStatus>;

export const BurnReviewStatus = z.enum(['pending_review', 'confirmed', 'rejected', 'superseded']);
export type BurnReviewStatus = z.infer<typeof BurnReviewStatus>;

export const BurnSourceType = z.enum([
  'bam.task',
  'bam.time_entry',
  'bill.expense',
  'bill.line_item',
  'bill.invoice',
]);
export type BurnSourceType = z.infer<typeof BurnSourceType>;

// A bam.task work item ALWAYS has valuation_basis='none' (R2-D1): time_logged_minutes
// appears in no epoch and no valuation, which is what stops the double count.
export const BurnValuationBasis = z.enum([
  'rate',
  'expense',
  'invoice',
  'none',
  'unrated',
  'no_cost_rate',
]);
export type BurnValuationBasis = z.infer<typeof BurnValuationBasis>;

export const BurnUnratedReason = z.enum([
  'no_rate_configured',
  'rate_service_unavailable',
  'currency_mismatch',
]);
export type BurnUnratedReason = z.infer<typeof BurnUnratedReason>;

// The work-item denormalization of burn_attributions.state. The two enums differ on
// purpose; the mapping is documented on the Drizzle table.
export const BurnWorkItemAttributionState = z.enum([
  'pending',
  'pending_attribution',
  'attributed',
  'pending_review',
  'unscoped',
  'excluded_non_billable',
  'excluded',
]);
export type BurnWorkItemAttributionState = z.infer<typeof BurnWorkItemAttributionState>;

export const BurnAttributionState = z.enum([
  'auto_attributed',
  'confirmed',
  'pending_review',
  'unscoped',
  'excluded_non_billable',
  'rejected',
]);
export type BurnAttributionState = z.infer<typeof BurnAttributionState>;

export const BurnUnscopedReason = z.enum([
  'no_matching_deliverable',
  'low_confidence',
  'no_active_engagement',
  'outside_engagement_window',
  'restatement_unmatched',
  'aged_out',
]);
export type BurnUnscopedReason = z.infer<typeof BurnUnscopedReason>;

export const BurnNonBillableReason = z.enum([
  'internal',
  'pre_sales',
  'pto',
  'warranty',
  'overhead',
  'rework',
]);
export type BurnNonBillableReason = z.infer<typeof BurnNonBillableReason>;

// 'inherited' is the 2.3.10 carry-forward marker. The predicate that preserves a human
// decision across a classification_epoch change MUST accept it, not only 'human', or the
// decision survives the first edit and is lost on the second (R3-T6).
export const BurnAttributionMethod = z.enum([
  'rule',
  'structural',
  'precedent',
  'lexical',
  'llm',
  'human',
  'inherited',
]);
export type BurnAttributionMethod = z.infer<typeof BurnAttributionMethod>;

// THE THREE BUCKETS ARE NEVER SUMMED INTO ONE (section 2.3.8).
export const BurnUnscopedBucket = z.enum([
  'sold_by_nobody',
  'unclassified',
  'outside_contract',
]);
export type BurnUnscopedBucket = z.infer<typeof BurnUnscopedBucket>;

export const BurnGateMode = z.enum(['off', 'advisory', 'blocking']);
export type BurnGateMode = z.infer<typeof BurnGateMode>;

export const BurnWorkRefType = z.enum([
  'bill.expense',
  'bill.recurring',
  'bam.task_phase_move',
  'bam.assignment',
  'subcontractor_charge',
  'manual',
]);
export type BurnWorkRefType = z.infer<typeof BurnWorkRefType>;

export const BurnPrecheckVerdict = z.enum(['allow', 'allow_with_note', 'needs_mapping', 'deny']);
export type BurnPrecheckVerdict = z.infer<typeof BurnPrecheckVerdict>;

export const BurnPrecheckVerdictReason = z.enum([
  'within_envelope',
  'envelope_exhausted',
  'envelope_would_exceed',
  'no_active_engagement',
  'engagement_unlinked',
  'deliverable_closed',
  'outside_engagement_window',
  'envelope_unpriced',
  'low_confidence_target',
  'gate_unavailable',
  'gate_not_configured',
  'gate_off',
  'gate_paused',
  'redis_unavailable',
]);
export type BurnPrecheckVerdictReason = z.infer<typeof BurnPrecheckVerdictReason>;

export const BurnPrecheckOutcome = z.enum([
  'pending',
  'proceeded',
  'abandoned',
  'overridden',
  'mapped',
  'mapped_and_posted',
  'change_order_raised',
  'absorbed',
]);
export type BurnPrecheckOutcome = z.infer<typeof BurnPrecheckOutcome>;

// Split by VALUE, not by row (section 2.4 point 9). right_call / would_have_mapped are
// member-writable on the caller's own non-enforced row and FEED NOTHING. wrong_call
// requires burn.precheck.mark_wrong and is the only value in the demotion numerator.
export const BurnAdvisoryFeedbackMemberWritable = z.enum(['right_call', 'would_have_mapped']);
export type BurnAdvisoryFeedbackMemberWritable = z.infer<
  typeof BurnAdvisoryFeedbackMemberWritable
>;

export const BurnAdvisoryFeedback = z.enum(['right_call', 'would_have_mapped', 'wrong_call']);
export type BurnAdvisoryFeedback = z.infer<typeof BurnAdvisoryFeedback>;

// 'gate_wrong' requires burn.precheck.mark_wrong (owner/admin). The other three are member
// reachable via burn.precheck.override.
export const BurnOverrideReasonCode = z.enum([
  'absorbed_cost',
  'mapped_manually',
  'change_order_pending',
  'gate_wrong',
]);
export type BurnOverrideReasonCode = z.infer<typeof BurnOverrideReasonCode>;

export const BurnVarianceKind = z.enum([
  'unscoped_work',
  'envelope_overrun',
  'envelope_at_risk',
  'silent_deliverable',
  'ungated_charge',
  'consumption_erosion',
  'phantom_consumption',
  'gate_outage',
  'rule_overreach',
  'awaiting_valuation',
  'precheck_probing',
]);
export type BurnVarianceKind = z.infer<typeof BurnVarianceKind>;

export const BurnVarianceSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type BurnVarianceSeverity = z.infer<typeof BurnVarianceSeverity>;

export const BurnVarianceStatus = z.enum(['open', 'acknowledged', 'resolved', 'dismissed']);
export type BurnVarianceStatus = z.infer<typeof BurnVarianceStatus>;

export const BurnRuleOutcomeKind = z.enum(['attribute', 'non_billable']);
export type BurnRuleOutcomeKind = z.infer<typeof BurnRuleOutcomeKind>;

/* ------------------------------------------------------------------ */
/*  The money block: a discriminated union on metric_basis            */
/* ------------------------------------------------------------------ */

// Minor units (cents), signed: a margin can be negative.
const minorUnits = z.number().int();
// Percentages are carried as numbers with two decimals, matching numeric(6,2).
const pct = z.number();

/**
 * THE MONEY BLOCK (section 1.2.2). Every response carrying a dollar or a derived
 * percentage embeds one of these, and it is a DISCRIMINATED UNION so a money-bearing
 * response is not CONSTRUCTIBLE without a discriminator.
 *
 * Why three members and not two, and why this must never be flattened into one object
 * with optional fields (round-3 R3-D5):
 *
 *   Section 6.1 cross-cutting rule (b) requires every money response to carry
 *   `metric_basis`, `revenue_basis`, `cost_rate_coverage_pct` and `as_of`.
 *   Section 2.4 point 17 requires `attributed_cost`, `margin_amount`, `margin_pct` and
 *   `cost_rate_coverage_pct` to be ABSENT -- not banded, not null, absent -- for a caller
 *   without burn.financials.read_all, because a member-visible cost band plus the
 *   per-person hour vector that Bam already exposes solves the cost-rate vector by least
 *   squares over a handful of daily snapshots.
 *
 *   Those two rules cannot both hold in a two-member union. The Gilligan seed deliberately
 *   builds a single-contributor chain, so this fires on the FIRST member-tier Portfolio
 *   Board load: either Zod validation fails, or an implementer loosens the union to
 *   optional fields, which reopens the exact hole the discriminator exists to close (a
 *   model reads `margin_amount` and drops the sibling `metric_basis` key that said the
 *   number is not margin).
 *
 *   The third member resolves it: suppression is its OWN variant, so the mandatory-field
 *   rule is satisfied per-variant and the floored keys are structurally absent.
 *
 * Consequences that are load-bearing:
 *   - Under `contract_consumption` there is NO `margin` key at all, which is what stops a
 *     model reading a field that is not there.
 *   - Under `suppressed` there is no cost, margin, or coverage key at all, and
 *     `suppressed_reason` gives ContributorFloorNotice a typed thing to render.
 *   - `contract_consumption_pct` is the member-safe figure. It derives from contract value
 *     and billable amounts, NOT from cost rates, which is why it survives suppression.
 *     (It is sourced from burn_engagement_rollups.consumption_pct; the wire name carries
 *     the `contract_` prefix so it can never be mistaken for a cost-consumption figure.)
 */
export const BurnMoneyTrueMargin = z.object({
  metric_basis: z.literal('true_margin'),
  revenue_basis: BurnRevenueBasis,
  currency: z.string().length(3),
  revenue_amount: minorUnits.nullable(),
  margin_amount: minorUnits.nullable(),
  margin_pct: pct.nullable(),
  attributed_cost: minorUnits.nullable(),
  attributed_billable: minorUnits.nullable(),
  contract_consumption_pct: pct.nullable(),
  cost_rate_coverage_pct: pct.nullable(),
  margin_state: BurnMarginState.nullable(),
  as_of: z.string(),
});
export type BurnMoneyTrueMargin = z.infer<typeof BurnMoneyTrueMargin>;

// No margin key AT ALL, including no `margin_state`. Cost-rate coverage is zero by
// definition here, which is exactly what makes `true_margin` unavailable.
//
// `margin_state` is deliberately absent rather than carried as null (spec section 6.1 lists
// it on /v1/financials generically, but section 12.1 asserts that no response carries the
// string "margin" when metric_basis='contract_consumption'). A key named `margin_state` on
// a response whose whole point is "this is not margin" is precisely the mislabeling that
// motivated renaming the burn_margin tool to burn_financials: a field name is a claim. The
// equivalent in-progress-vs-final signal for this variant is `completion_state`.
export const BurnMoneyContractConsumption = z.object({
  metric_basis: z.literal('contract_consumption'),
  revenue_basis: BurnRevenueBasis,
  currency: z.string().length(3),
  contract_value: minorUnits.nullable(),
  attributed_billable: minorUnits.nullable(),
  contract_consumption_pct: pct.nullable(),
  cost_rate_coverage_pct: pct.nullable(),
  completion_state: BurnMarginState.nullable(),
  as_of: z.string(),
});
export type BurnMoneyContractConsumption = z.infer<typeof BurnMoneyContractConsumption>;

// The member-tier response. NO cost, margin, or coverage key exists on this variant --
// not optional, not nullable, not present. `.strict()` makes an accidental spread of a
// cost-bearing object a hard validation failure rather than a silent leak.
export const BurnMoneySuppressed = z
  .object({
    metric_basis: z.literal('suppressed'),
    suppressed_reason: BurnSuppressedReason,
    revenue_basis: BurnRevenueBasis,
    currency: z.string().length(3),
    contract_consumption_pct: pct.nullable(),
    as_of: z.string(),
  })
  .strict();
export type BurnMoneySuppressed = z.infer<typeof BurnMoneySuppressed>;

export const BurnMoneyBlock = z.discriminatedUnion('metric_basis', [
  BurnMoneyTrueMargin,
  BurnMoneyContractConsumption,
  BurnMoneySuppressed,
]);
export type BurnMoneyBlock = z.infer<typeof BurnMoneyBlock>;

// The keys that may NEVER appear on a response to a caller without
// burn.financials.read_all. Exported so the burn-api serializer and its tests share one
// list, and so a new floored column cannot be added in one place and forgotten in the
// other. Consumed by apps/burn-api/src/lib/redact-financial-fields.ts.
export const BURN_READ_ALL_FLOORED_KEYS = [
  // Per-row money. For a single bam.time_entry row, cost_amount / (minutes / 60) IS that
  // person's hourly cost rate to the cent (R2-S3). One row is a full disclosure.
  'cost_amount',
  'billable_amount',
  'bill_rate_id',
  'burn_cost_rate_id',
  // Aggregates (section 2.4 point 17).
  'attributed_cost',
  'attributed_billable',
  'margin_amount',
  'margin_pct',
  'cost_rate_coverage_pct',
  'revenue_amount',
  // Contract and envelope magnitudes. A deliverable with zero consumption has
  // remaining == envelope_amount, so probing recovers contract_value exactly (R2-S2).
  'contract_value',
  'contract_value_delta',
  'envelope_amount',
  'envelope_amount_delta',
  'envelope_hours',
  'envelope_consumed',
  'envelope_remaining',
  'overage_amount',
  // Variance and queue magnitudes.
  'amount',
  'unscoped_sold_by_nobody',
  'unscoped_unclassified',
  'unscoped_outside_contract',
  'pending_review_amount',
  'awaiting_valuation_amount',
  'non_billable_amount',
  'unscoped_alert_floor',
] as const;
export type BurnReadAllFlooredKey = (typeof BURN_READ_ALL_FLOORED_KEYS)[number];

// Clause text floored alongside the money (section 2.4 point 5). `title` stays as the
// member-visible handle; `description` is the same content one paraphrase removed, so
// flooring `quote` alone launders it.
export const BURN_READ_ALL_FLOORED_CLAUSE_KEYS = ['description', 'clause_ref', 'quote'] as const;
export type BurnReadAllFlooredClauseKey = (typeof BURN_READ_ALL_FLOORED_CLAUSE_KEYS)[number];

/* ------------------------------------------------------------------ */
/*  JSONB shapes (section 3.3)                                        */
/* ------------------------------------------------------------------ */

// `quote` is floored to burn.financials.read_all (section 2.4 point 5).
export const BurnCitedSpan = z.object({
  page: z.number().int().positive().nullable().optional(),
  char_start: z.number().int().nonnegative().nullable().optional(),
  char_end: z.number().int().nonnegative().nullable().optional(),
  quote: z.string().max(2000).nullable().optional(),
  clause_ref: z.string().max(64).nullable().optional(),
});
export type BurnCitedSpan = z.infer<typeof BurnCitedSpan>;

// The rule match predicate. An EMPTY match is rejected here AND by a DB CHECK: a rule that
// matches everything silently attributes the whole ledger to one deliverable (R2-S4a).
// `title_pattern` rejects regex metacharacters because Node has no regex timeout.
const TITLE_PATTERN_SAFE = /^[^\\^$.|?*+()[\]{}]*$/;

export const BurnRuleMatch = z
  .object({
    source_types: z.array(BurnSourceType).min(1).optional(),
    project_ids: z.array(z.string().uuid()).min(1).optional(),
    actor_ids: z.array(z.string().uuid()).min(1).optional(),
    phase_ids: z.array(z.string().uuid()).min(1).optional(),
    label_ids: z.array(z.string().uuid()).min(1).optional(),
    title_pattern: z
      .string()
      .min(1)
      .max(200)
      .regex(TITLE_PATTERN_SAFE, 'title_pattern may not contain regex metacharacters')
      .optional(),
  })
  .strict()
  .refine((m) => Object.values(m).some((v) => v !== undefined), {
    message: 'a rule match must constrain at least one discriminating key',
  });
export type BurnRuleMatch = z.infer<typeof BurnRuleMatch>;

// Variance detail. `refs` is capped by variance_detail_max_refs. The whole object passes
// through redactFinancialFields, which recurses, so a money key nested here is floored too.
export const BurnVarianceDetail = z.object({
  refs: z
    .array(
      z.object({
        entity_type: z.string().max(64),
        entity_id: z.string().uuid(),
        label: z.string().max(512).optional(),
      }),
    )
    .max(200)
    .optional(),
  band: z.string().max(32).optional(),
  note: z.string().max(2000).optional(),
  hidden_by_permissions: z.number().int().nonnegative().optional(),
});
export type BurnVarianceDetail = z.infer<typeof BurnVarianceDetail>;

/* ------------------------------------------------------------------ */
/*  Common query shapes                                               */
/* ------------------------------------------------------------------ */

export const burnListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(64).optional(),
  // An agent narrows a read to the human it acts for. It NEVER widens: see the
  // bearer-intersect-asker rule in section 2.4 point 2.
  asker_user_id: z.string().uuid().optional(),
});
export type BurnListQuery = z.infer<typeof burnListQuerySchema>;

/* ------------------------------------------------------------------ */
/*  Engagements                                                       */
/* ------------------------------------------------------------------ */

export const burnEngagementCreateSchema = z.object({
  title: z.string().min(1).max(512),
  engagement_kind: BurnEngagementKind.default('sow'),
  amends_engagement_id: z.string().uuid().nullable().optional(),
  supersedes_engagement_id: z.string().uuid().nullable().optional(),
  contract_value: minorUnits.nullable().optional(),
  contract_value_delta: minorUnits.nullable().optional(),
  currency: z.string().length(3).default('USD'),
  envelope_basis: BurnEnvelopeBasis.default('fixed'),
  period_length_days: z.number().int().positive().nullable().optional(),
  budget_hours: z.number().nonnegative().nullable().optional(),
  bin_asset_id: z.string().uuid().nullable().optional(),
  account_type: z.string().max(32).nullable().optional(),
  account_id: z.string().uuid().nullable().optional(),
  bill_client_id: z.string().uuid().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  timezone: z.string().max(64).default('UTC'),
  project_ids: z.array(z.string().uuid()).default([]),
});
export type BurnEngagementCreate = z.infer<typeof burnEngagementCreateSchema>;

// A retainer with no period length has no period boundaries, so its per-period revenue is
// undefined. Mirrors the DB CHECK in migration 0239.
export const burnEngagementCreateRefined = burnEngagementCreateSchema.refine(
  (v) => v.envelope_basis !== 'retainer' || (v.period_length_days ?? 0) > 0,
  { message: 'period_length_days is required when envelope_basis is retainer', path: ['period_length_days'] },
);

export const burnEngagementUpdateSchema = burnEngagementCreateSchema.partial().extend({
  status: BurnEngagementStatus.optional(),
});
export type BurnEngagementUpdate = z.infer<typeof burnEngagementUpdateSchema>;

/* ------------------------------------------------------------------ */
/*  Deliverables                                                      */
/* ------------------------------------------------------------------ */

// PATCH /v1/deliverables/:id CANNOT touch envelope_amount or is_active (R2-D4). is_active
// is written by exactly one code path: POST /v1/deliverables/:id/confirm-envelope, under
// burn.envelope.confirm, and never by any service-account token on any path. `.strict()`
// makes an attempt to smuggle either key a 400 rather than a silent no-op.
export const burnDeliverableUpdateSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(20000).nullable().optional(),
    deliverable_kind: BurnDeliverableKind.optional(),
    due_date: z.string().nullable().optional(),
    review_status: BurnReviewStatus.optional(),
    lifecycle_status: BurnLifecycleStatus.optional(),
  })
  .strict();
export type BurnDeliverableUpdate = z.infer<typeof burnDeliverableUpdateSchema>;

export const burnConfirmEnvelopeSchema = z.object({
  envelope_amount: minorUnits.nullable(),
  envelope_hours: z.number().nonnegative().nullable().optional(),
  envelope_source: BurnEnvelopeSource.default('human'),
});
export type BurnConfirmEnvelope = z.infer<typeof burnConfirmEnvelopeSchema>;

// The fast path confirms N deliverables as `unpriced`. NEVER an even split (2.2.2): an
// even split invents a number the contract does not contain and then denies charges
// against it.
export const burnBulkConfirmUnpricedSchema = z.object({
  deliverable_ids: z.array(z.string().uuid()).min(1).max(200),
});
export type BurnBulkConfirmUnpriced = z.infer<typeof burnBulkConfirmUnpricedSchema>;

/* ------------------------------------------------------------------ */
/*  Attributions                                                      */
/* ------------------------------------------------------------------ */

export const burnAttributionCreateSchema = z.object({
  work_item_id: z.string().uuid(),
  deliverable_id: z.string().uuid().nullable(),
  state: BurnAttributionState,
  non_billable_reason: BurnNonBillableReason.nullable().optional(),
  rationale: z.string().max(2000).nullable().optional(),
});
export type BurnAttributionCreate = z.infer<typeof burnAttributionCreateSchema>;

export const burnAttributionUpdateSchema = z.object({
  deliverable_id: z.string().uuid().nullable().optional(),
  state: BurnAttributionState.optional(),
  unscoped_reason: BurnUnscopedReason.nullable().optional(),
  non_billable_reason: BurnNonBillableReason.nullable().optional(),
  rationale: z.string().max(2000).nullable().optional(),
  // Stale-write check: a concurrent triage returns 409 with the current state.
  updated_at: z.string().optional(),
});
export type BurnAttributionUpdate = z.infer<typeof burnAttributionUpdateSchema>;

export const burnAttributionBulkSchema = z.object({
  attribution_ids: z.array(z.string().uuid()).min(1).max(200),
  action: burnAttributionUpdateSchema,
});
export type BurnAttributionBulk = z.infer<typeof burnAttributionBulkSchema>;

export const burnBulkItemResult = z.object({
  id: z.string().uuid(),
  status: z.enum(['applied', 'conflicted', 'failed']),
  message: z.string().optional(),
});
export type BurnBulkItemResult = z.infer<typeof burnBulkItemResult>;

export const burnBulkResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  conflicted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(burnBulkItemResult),
});
export type BurnBulkResult = z.infer<typeof burnBulkResultSchema>;

/* ------------------------------------------------------------------ */
/*  Rules                                                             */
/* ------------------------------------------------------------------ */

export const burnRuleCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    priority: z.number().int().min(0).max(10000).default(100),
    match: BurnRuleMatch,
    outcome_kind: BurnRuleOutcomeKind,
    outcome_deliverable_id: z.string().uuid().nullable().optional(),
    outcome_reason: BurnNonBillableReason.nullable().optional(),
    is_enabled: z.boolean().default(true),
  })
  .refine((v) => v.outcome_kind !== 'attribute' || !!v.outcome_deliverable_id, {
    message: 'outcome_deliverable_id is required when outcome_kind is attribute',
    path: ['outcome_deliverable_id'],
  })
  .refine((v) => v.outcome_kind !== 'non_billable' || !!v.outcome_reason, {
    message: 'outcome_reason is required when outcome_kind is non_billable',
    path: ['outcome_reason'],
  });
export type BurnRuleCreate = z.infer<typeof burnRuleCreateSchema>;

/* ------------------------------------------------------------------ */
/*  The gate                                                          */
/* ------------------------------------------------------------------ */

// The idempotency key is SERVER-DERIVED (section 2.4 point 7). A caller-supplied key is
// rejected: `.strict()` plus the absence of any key field is the enforcement.
export const burnPrecheckRequestSchema = z
  .object({
    work_ref_type: BurnWorkRefType,
    work_ref_id: z.string().uuid().nullable().optional(),
    project_id: z.string().uuid().nullable().optional(),
    proposed_amount: minorUnits,
    currency: z.string().length(3),
    title: z.string().max(512).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    occurred_at: z.string().nullable().optional(),
    attempt_nonce: z.string().max(64).nullable().optional(),
  })
  .strict();
export type BurnPrecheckRequest = z.infer<typeof burnPrecheckRequestSchema>;

// The internal (bill-api) form adds the org, which is derived from the VALIDATED PAYLOAD
// and used to set the RLS GUC in the same transaction (section 2.4 point 14).
export const burnInternalPrecheckRequestSchema = burnPrecheckRequestSchema.extend({
  organization_id: z.string().uuid(),
  acting_user_id: z.string().uuid().nullable().optional(),
});
export type BurnInternalPrecheckRequest = z.infer<typeof burnInternalPrecheckRequestSchema>;

// What the caller sees (section 5.7). The envelope figures are present ONLY for a
// burn.financials.read_all caller; a member gets `consumption_band` and a `quantized`
// overage rounded UP to overage_bucket_amount, and the deny is EVALUATED against a
// remaining figure rounded DOWN to the same bucket, so binary search over proposed_amount
// cannot recover finer than one bucket (R3-S3).
export const burnPrecheckResponseSchema = z.object({
  precheck_id: z.string().uuid(),
  verdict: BurnPrecheckVerdict,
  verdict_reason: BurnPrecheckVerdictReason,
  enforced: z.boolean(),
  mode_at_decision: BurnGateMode,
  engagement_id: z.string().uuid().nullable(),
  deliverable_id: z.string().uuid().nullable(),
  confidence: z.number().nullable(),
  consumption_band: z.string().max(32).nullable(),
  overage_amount_quantized: minorUnits.nullable(),
  overage_bucket_amount: minorUnits.nullable(),
  // read_all only. Absent, not null, for anyone else: the serializer deletes the keys.
  envelope_amount: minorUnits.nullable().optional(),
  envelope_consumed: minorUnits.nullable().optional(),
  envelope_remaining: minorUnits.nullable().optional(),
  overage_amount: minorUnits.nullable().optional(),
  clause_ref: z.string().max(64).nullable().optional(),
  valid_until: z.string(),
  latency_ms: z.number().int().nonnegative().nullable(),
});
export type BurnPrecheckResponse = z.infer<typeof burnPrecheckResponseSchema>;

export const burnPrecheckOverrideSchema = z.object({
  override_reason_code: z.enum(['absorbed_cost', 'mapped_manually', 'change_order_pending']),
  override_reason_text: z.string().min(1).max(2000),
});
export type BurnPrecheckOverride = z.infer<typeof burnPrecheckOverrideSchema>;

// One route, two authorities. right_call / would_have_mapped need only burn.precheck.run
// on the caller's OWN non-enforced row and feed nothing; wrong_call and gate_wrong need
// burn.precheck.mark_wrong (owner/admin) and are the only values in the demotion
// numerator (section 2.4 point 9). The union keeps the two authorities visible in the type
// rather than hiding them behind one optional string.
export const burnPrecheckLabelSchema = z.union([
  z.object({ advisory_feedback: BurnAdvisoryFeedbackMemberWritable }).strict(),
  z.object({ advisory_feedback: z.literal('wrong_call') }).strict(),
  z.object({ override_reason_code: z.literal('gate_wrong') }).strict(),
  // Enqueue for review WITHOUT labeling. This is what the inline member control's third
  // option writes, so a member never needs a 403 to express "this looks wrong".
  z.object({ flag_for_review: z.literal(true) }).strict(),
]);
export type BurnPrecheckLabel = z.infer<typeof burnPrecheckLabelSchema>;

export const burnPrecheckOutcomeSchema = z.object({
  outcome: BurnPrecheckOutcome,
  work_ref_id: z.string().uuid().nullable().optional(),
});
export type BurnPrecheckOutcome_ = z.infer<typeof burnPrecheckOutcomeSchema>;

/* ------------------------------------------------------------------ */
/*  Variances and change orders                                       */
/* ------------------------------------------------------------------ */

export const burnVarianceUpdateSchema = z.object({
  status: z.enum(['acknowledged', 'resolved', 'dismissed']),
  note: z.string().max(2000).optional(),
});
export type BurnVarianceUpdate = z.infer<typeof burnVarianceUpdateSchema>;

export const burnChangeOrderDraftSchema = z.object({
  variance_id: z.string().uuid().nullable().optional(),
  engagement_id: z.string().uuid(),
  deliverable_id: z.string().uuid().nullable().optional(),
  note: z.string().max(4000).optional(),
});
export type BurnChangeOrderDraft = z.infer<typeof burnChangeOrderDraftSchema>;

/* ------------------------------------------------------------------ */
/*  Cost rates                                                        */
/* ------------------------------------------------------------------ */

// Precedence is user+project > user > project > org, and effective_to is INCLUSIVE,
// matching bill-api rate.service.ts:117. A write enqueues burn-revalue.
export const burnCostRateCreateSchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  user_id: z.string().uuid().nullable().optional(),
  cost_amount: minorUnits.nonnegative(),
  rate_type: z.enum(['hourly']).default('hourly'),
  currency: z.string().length(3).default('USD'),
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
  note: z.string().max(255).nullable().optional(),
});
export type BurnCostRateCreate = z.infer<typeof burnCostRateCreateSchema>;

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

// gate_mode promotion to 'blocking' is checked SERVER-SIDE against all seven section 5.4
// preconditions; Zod only validates shape.
export const burnSettingsUpdateSchema = z
  .object({
    gate_mode: BurnGateMode.optional(),
    gate_enabled_refs: z.array(BurnWorkRefType).optional(),
    gate_paused_until: z.string().nullable().optional(),
    deny_threshold: z.number().min(0).max(1).optional(),
    map_threshold: z.number().min(0).max(1).optional(),
    auto_attribute_threshold: z.number().min(0).max(1).optional(),
    review_threshold: z.number().min(0).max(1).optional(),
    pending_review_max_age_days: z.number().int().positive().max(3650).optional(),
    reconcile_window_days: z.number().int().positive().max(3650).optional(),
    overage_bucket_amount: minorUnits.positive().optional(),
    min_contributors_for_cost_aggregate: z.number().int().min(1).max(100).optional(),
    match_ceiling_pct: z.number().min(0).max(100).optional(),
    usr_precheck_daily_cap: z.number().int().positive().optional(),
    usr_precheck_per_deliverable_cap: z.number().int().positive().optional(),
    override_reason_min_chars: z.number().int().min(0).max(2000).optional(),
    unscoped_alert_floor: minorUnits.nonnegative().optional(),
    candidate_k: z.number().int().min(1).max(50).optional(),
    exemplar_k: z.number().int().min(0).max(50).optional(),
    attribution_llm_daily_cap: z.number().int().nonnegative().optional(),
    attribute_batch_size: z.number().int().min(1).max(500).optional(),
    embedding_enabled: z.boolean().optional(),
    banter_signal_enabled: z.boolean().optional(),
    vcs_signal_enabled: z.boolean().optional(),
    // Org ownership is validated server-side regardless of what the caller sends:
    // apps/api internal-llm.routes.ts resolves a provider by id and enabled only, with no
    // org predicate (section 2.4 point 12).
    llm_provider_id: z.string().uuid().nullable().optional(),
    work_item_retention_days: z.number().int().positive().max(36500).optional(),
    ingest_retention_days: z.number().int().positive().max(36500).optional(),
  })
  .strict();
export type BurnSettingsUpdate = z.infer<typeof burnSettingsUpdateSchema>;

/* ------------------------------------------------------------------ */
/*  Realtime frames (section 6.2)                                     */
/* ------------------------------------------------------------------ */

// Refs and coarse bands ONLY. No client names, no clause text, no dollars. Frames are
// advisory: the client refetches the affected TanStack Query keys on reconnect rather than
// replaying, so no frame is load-bearing for correctness.
export const burnWsFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('unscoped.detected'),
    work_item_id: z.string().uuid(),
    engagement_id: z.string().uuid().nullable(),
    bucket: BurnUnscopedBucket,
    band: z.string().max(32),
  }),
  z.object({
    type: z.literal('precheck.decided'),
    precheck_id: z.string().uuid(),
    verdict: BurnPrecheckVerdict,
    engagement_id: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal('variance.detected'),
    variance_id: z.string().uuid(),
    kind: BurnVarianceKind,
    severity: BurnVarianceSeverity,
    engagement_id: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal('attribution.reviewed'),
    attribution_id: z.string().uuid(),
    state: BurnAttributionState,
  }),
  z.object({
    type: z.literal('gate.mode_changed'),
    mode: BurnGateMode,
    reason: z.string().max(120),
  }),
]);
export type BurnWsFrame = z.infer<typeof burnWsFrameSchema>;
