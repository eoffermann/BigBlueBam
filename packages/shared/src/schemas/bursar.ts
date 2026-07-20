import { z } from 'zod';

// Bursar (AI absence-detection / bid-leveling + scope-drift monitor) schemas.
//
// This module owns the request/response shapes shared between bursar-api, the /bursar SPA,
// and the bursar_* MCP tools. M2 covers vendors, payee aliases, requests, and org settings;
// later milestones (offers, leveling, awards, spend, drafts) extend it.
//
// See docs/brainstorming/2026_07_19_20_05_APP_DESIGN_bursar.md sections 6.1, 11, and 13.

/* ------------------------------------------------------------------ */
/*  Common query shapes                                               */
/* ------------------------------------------------------------------ */

// Cursor pagination + ?filter[field]= + ?sort=-field, plus the asker narrowing. An agent
// narrows a read to the human it acts for with asker_user_id; it NEVER widens (spec 13.3,
// the bearer-intersect-asker rule ported from burn).
export const bursarListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(64).optional(),
  asker_user_id: z.string().uuid().optional(),
});
export type BursarListQuery = z.infer<typeof bursarListQuerySchema>;

/* ------------------------------------------------------------------ */
/*  Vendors                                                           */
/* ------------------------------------------------------------------ */

export const BursarVendorCriticality = z.enum(['low', 'standard', 'high', 'critical']);
export type BursarVendorCriticality = z.infer<typeof BursarVendorCriticality>;

export const BursarVendorStatus = z.enum(['active', 'archived']);
export type BursarVendorStatus = z.infer<typeof BursarVendorStatus>;

export const bursarVendorCreateSchema = z.object({
  display_name: z.string().min(1).max(512),
  category: z.string().max(64).nullable().optional(),
  criticality: BursarVendorCriticality.default('standard'),
  owner_user_id: z.string().uuid().nullable().optional(),
  // Dotted cross-app refs (no cross-schema FK). bond_company_id feeds the Braid resolve.
  bond_company_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type BursarVendorCreate = z.infer<typeof bursarVendorCreateSchema>;

export const bursarVendorUpdateSchema = z
  .object({
    display_name: z.string().min(1).max(512),
    category: z.string().max(64).nullable(),
    criticality: BursarVendorCriticality,
    owner_user_id: z.string().uuid().nullable(),
    bond_company_id: z.string().uuid().nullable(),
    notes: z.string().max(4000).nullable(),
    status: BursarVendorStatus,
  })
  .partial();
export type BursarVendorUpdate = z.infer<typeof bursarVendorUpdateSchema>;

/* ------------------------------------------------------------------ */
/*  Payee aliases                                                     */
/* ------------------------------------------------------------------ */

// A human confirming (or correcting) a payee->vendor link. `raw_payee` is the observed card
// string; the server normalizes it. A caller cannot set `source` or `confidence`: a human
// confirmation is always source='human' at confidence 1.0.
export const bursarAliasCreateSchema = z.object({
  raw_payee: z.string().min(1).max(512),
});
export type BursarAliasCreate = z.infer<typeof bursarAliasCreateSchema>;

/* ------------------------------------------------------------------ */
/*  Requests                                                          */
/* ------------------------------------------------------------------ */

export const bursarRequestCreateSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(8000).nullable().optional(),
  currency: z.string().length(3).default('USD'),
  // Optional Bin source document. When present it is access-checked (spec 5.8) and the
  // resolved version is pinned before the request row is written.
  bin_asset_id: z.string().uuid().nullable().optional(),
});
export type BursarRequestCreate = z.infer<typeof bursarRequestCreateSchema>;

export const bursarRequestUpdateSchema = z
  .object({
    title: z.string().min(1).max(512),
    description: z.string().max(8000).nullable(),
    status: z.string().max(16),
    // Attaching (or replacing) the Bin source document re-runs the §5.8 access check.
    bin_asset_id: z.string().uuid().nullable(),
  })
  .partial();
export type BursarRequestUpdate = z.infer<typeof bursarRequestUpdateSchema>;

/* ------------------------------------------------------------------ */
/*  Org settings                                                      */
/* ------------------------------------------------------------------ */

// Every knob is optional (PATCH semantics). ALL of these are audited with a before/after
// diff (spec 5.6): zeroing a weight to silently suppress findings must leave a trail.
const pct = z.coerce.number();
export const bursarSettingsUpdateSchema = z
  .object({
    llm_provider_id: z.string().uuid().nullable(),
    node_term_overlap_floor: z.coerce.number().min(0).max(1),
    blanket_fanout_cap: z.coerce.number().int().min(0),
    blanket_cumulative_cap: z.coerce.number().int().min(0),
    evidence_concentration_floor: z.coerce.number().min(0).max(1),
    max_nodes_per_run: z.coerce.number().int().min(1),
    max_offers_per_run: z.coerce.number().int().min(1),
    max_llm_calls_per_run: z.coerce.number().int().min(1),
    max_lines_per_window: z.coerce.number().int().min(1),
    window_overlap_lines: z.coerce.number().int().min(0),
    price_drift_threshold_pct: pct,
    renewal_lead_bands: z.array(z.string().max(32)).max(24),
    parse_quality_floor: z.coerce.number().min(0).max(1),
    payee_match_threshold: z.coerce.number().min(0).max(1),
    payee_auto_accept_threshold: z.coerce.number().min(0).max(1),
    blanket_lexicon: z.array(z.string().max(256)).max(500),
    exclusion_lexicon: z.array(z.string().max(256)).max(500),
    digest_day: z.coerce.number().int().min(0).max(31),
    digest_hour: z.coerce.number().int().min(0).max(23),
    retention_days: z.coerce.number().int().min(1),
  })
  .partial();
export type BursarSettingsUpdate = z.infer<typeof bursarSettingsUpdateSchema>;

// The set of setting keys that are audited. Kept as data so the audit builder cannot forget
// a field: a diff is computed over exactly these keys (spec 5.6). Excludes the row's
// identity/bookkeeping columns (organization_id, updated_by, updated_at).
export const BURSAR_AUDITED_SETTING_KEYS = [
  'llm_provider_id',
  'node_term_overlap_floor',
  'blanket_fanout_cap',
  'blanket_cumulative_cap',
  'evidence_concentration_floor',
  'max_nodes_per_run',
  'max_offers_per_run',
  'max_llm_calls_per_run',
  'max_lines_per_window',
  'window_overlap_lines',
  'price_drift_threshold_pct',
  'renewal_lead_bands',
  'parse_quality_floor',
  'payee_match_threshold',
  'payee_auto_accept_threshold',
  'blanket_lexicon',
  'exclusion_lexicon',
  'digest_day',
  'digest_hour',
  'retention_days',
] as const;
export type BursarAuditedSettingKey = (typeof BURSAR_AUDITED_SETTING_KEYS)[number];

/* ------------------------------------------------------------------ */
/*  Scope tree (M3): derivation, nodes, library, confirm, promote     */
/* ------------------------------------------------------------------ */

// The derived_from precedence (spec 3.2): a request node is `mandatory` by default; a library
// node is `should_have`; a rival-offer node is `nice_to_have` and never auto-published; a human
// node carries the strength it is given.
export const BursarNormativeStrength = z.enum([
  'mandatory',
  'should_have',
  'nice_to_have',
  'informational',
]);
export type BursarNormativeStrength = z.infer<typeof BursarNormativeStrength>;

export const BursarDerivedFrom = z.enum(['request', 'library', 'rival_offer', 'human']);
export type BursarDerivedFrom = z.infer<typeof BursarDerivedFrom>;

// The scope_status state machine (spec 3.2): pending -> deriving -> derived -> confirmed.
// `none` is the migration's resting default and is treated as equivalent to `pending`; `awarded`
// is a downstream state used post-award.
export const BursarScopeStatus = z.enum([
  'none',
  'pending',
  'deriving',
  'derived',
  'confirmed',
  'awarded',
]);
export type BursarScopeStatus = z.infer<typeof BursarScopeStatus>;

// Kick off async-start derivation. An optional inline `source_text` overrides the Bin document
// (used when the request carries no Bin asset and for tests); otherwise the worker reads the
// pinned Bin bytes.
export const bursarDeriveScopeSchema = z
  .object({
    source_text: z.string().max(2_000_000),
  })
  .partial();
export type BursarDeriveScope = z.infer<typeof bursarDeriveScopeSchema>;

// A hand-added scope node (derived_from = 'human').
export const bursarScopeNodeCreateSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(4000).nullable().optional(),
  node_kind: z.string().max(32).default('requirement'),
  normative_strength: BursarNormativeStrength.default('mandatory'),
  unit: z.string().max(32).nullable().optional(),
  quantity: z.coerce.number().nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
});
export type BursarScopeNodeCreate = z.infer<typeof bursarScopeNodeCreateSchema>;

export const bursarScopeNodeUpdateSchema = z
  .object({
    title: z.string().min(1).max(512),
    description: z.string().max(4000).nullable(),
    node_kind: z.string().max(32),
    normative_strength: BursarNormativeStrength,
    unit: z.string().max(32).nullable(),
    quantity: z.coerce.number().nullable(),
    review_status: z.enum(['pending_review', 'confirmed']),
  })
  .partial();
export type BursarScopeNodeUpdate = z.infer<typeof bursarScopeNodeUpdateSchema>;

// Apply one or more library entries (built-in globals or the org's own) into the tree as
// `should_have` nodes.
export const bursarApplyLibrarySchema = z.object({
  library_ids: z.array(z.string().uuid()).min(1).max(200),
});
export type BursarApplyLibrary = z.infer<typeof bursarApplyLibrarySchema>;

// Confirm the tree. `clear_injection` lets an admin acknowledge and clear the flagged
// injection spans in the same floored action, so the confirm is not permanently wedged; without
// it, a request with `injection_suspected` is blocked (spec 5.5).
export const bursarConfirmScopeSchema = z
  .object({
    clear_injection: z.boolean(),
  })
  .partial();
export type BursarConfirmScope = z.infer<typeof bursarConfirmScopeSchema>;

// Promote a rival-derived proposal into the counted tree. The promoter acknowledges the
// supporting offers they were shown; the server echoes `contributing_offer_ids` into the audit
// (spec 4.5).
export const bursarPromoteRivalSchema = z
  .object({
    acknowledged_offer_ids: z.array(z.string().uuid()).max(50),
  })
  .partial();
export type BursarPromoteRival = z.infer<typeof bursarPromoteRivalSchema>;

/* ------------------------------------------------------------------ */
/*  Internal engine transport (M3)                                    */
/* ------------------------------------------------------------------ */

// The org comes from the VALIDATED payload on these session-less internal routes.
export const bursarRunDerivationSchema = z.object({
  organization_id: z.string().uuid(),
  request_id: z.string().uuid(),
  run_id: z.string().uuid(),
  source_text: z.string().max(4_000_000),
  source_doc_hash: z.string().max(64).nullable().optional(),
  claimant: z.string().min(1).max(64),
});
export type BursarRunDerivation = z.infer<typeof bursarRunDerivationSchema>;

export const bursarRunReaperSchema = z
  .object({
    // Omit to sweep every org that has stale work.
    organization_id: z.string().uuid().optional(),
    lease_ms: z.coerce.number().int().positive().max(3_600_000).optional(),
  })
  .partial();
export type BursarRunReaper = z.infer<typeof bursarRunReaperSchema>;

// BullMQ queue for async-start derivation. bursar-api is the producer; the worker consumer
// registration lands in M8.
export const BURSAR_DERIVE_SCOPE_QUEUE = 'bursar-derive-scope';
export interface BursarDeriveScopeJobData {
  organization_id: string;
  request_id: string;
  run_id: string;
  /** Inline source text; absent when the worker must read the pinned Bin bytes itself. */
  source_text?: string;
}

/* ------------------------------------------------------------------ */
/*  Offers (M4): ingest and deterministic parse (Stage 1, NO LLM)     */
/* ------------------------------------------------------------------ */

// The source format an offer document was declared as. Content-type pinning (spec 5.4) checks
// the detected magic bytes against this declared value, so a PDF header on a file declared
// `csv` is rejected before it is parsed. `xlsx` means an XLSX the caller exported to a text
// codec; the raw .xlsx zip container is NOT parsed in v1 (no OCR, no zip extraction).
export const BursarSourceFormat = z.enum([
  'text',
  'email',
  'pdf',
  'csv',
  'tsv',
  'jsonl',
  'json',
  'yaml',
  'xlsx',
]);
export type BursarSourceFormat = z.infer<typeof BursarSourceFormat>;

// The line role (spec 6.1 / 4.4). ONLY `base` counts toward coverage and totals; the others are
// carried for provenance but never contribute a covered node or a priced total.
export const BursarLineRole = z.enum(['base', 'option', 'alternate', 'allowance', 'note']);
export type BursarLineRole = z.infer<typeof BursarLineRole>;

// The parse lifecycle state persisted on bursar_offers.normalization_status. `unparseable` is a
// terminal state that (spec 4.1) can NEVER produce an `absent` verdict downstream: "we could not
// read it" is not evidence of omission. `blocked` is a §5.8 re-assertion / limits failure.
export const BursarNormalizationStatus = z.enum([
  'pending',
  'parsing',
  'parsed',
  'unparseable',
  'blocked',
  'failed',
]);
export type BursarNormalizationStatus = z.infer<typeof BursarNormalizationStatus>;

// Create an offer under a request. The byte source is EITHER a Bin asset (access-checked via
// §5.8 and version-pinned, exactly like a request document) OR inline `source_text` for a pasted
// text/email offer. `sealed_until` opens the offer under the shared seal predicate (spec 5.6).
export const bursarOfferCreateSchema = z.object({
  vendor_id: z.string().uuid().nullable().optional(),
  label: z.string().max(512).nullable().optional(),
  currency: z.string().length(3).default('USD'),
  bin_asset_id: z.string().uuid().nullable().optional(),
  source_text: z.string().max(4_000_000).nullable().optional(),
  source_format: BursarSourceFormat.nullable().optional(),
  sealed_until: z.string().datetime({ offset: true }).nullable().optional(),
});
export type BursarOfferCreate = z.infer<typeof bursarOfferCreateSchema>;

// The upload/ingest body (POST /offers/:id/upload). Accepts a Bin asset reference to (re)attach
// and pin, or inline text, then kicks off the deterministic parse. Sent as JSON or as multipart
// form fields; the multipart file part, when present, is the inline document bytes.
export const bursarOfferUploadSchema = z.object({
  bin_asset_id: z.string().uuid().nullable().optional(),
  source_text: z.string().max(4_000_000).nullable().optional(),
  source_format: BursarSourceFormat.nullable().optional(),
  vendor_id: z.string().uuid().nullable().optional(),
});
export type BursarOfferUpload = z.infer<typeof bursarOfferUploadSchema>;

// Unseal a sealed offer (floored, confirm-required). Every unseal writes activity_log and
// publishes offer.unsealed (spec 5.6). The reason is recorded on the audit row.
export const bursarUnsealOfferSchema = z
  .object({
    reason: z.string().max(1000),
  })
  .partial();
export type BursarUnsealOffer = z.infer<typeof bursarUnsealOfferSchema>;

/* ------------------------------------------------------------------ */
/*  Internal engine transport (M4 offer parse)                        */
/* ------------------------------------------------------------------ */

// The org comes from the VALIDATED payload on this session-less internal route. The worker sends
// the raw document bytes base64-encoded (`source_bytes_b64`, the canonical path for PDFs and
// structured files) OR pre-decoded `source_text` (inline text/email offers and tests). Exactly
// one is required. `declared_format` drives content-type pinning; `byte_len` is the pre-decode
// size for the malicious-document ceiling.
export const bursarParseOfferSchema = z
  .object({
    organization_id: z.string().uuid(),
    offer_id: z.string().uuid(),
    claimant: z.string().min(1).max(64),
    source_text: z.string().max(4_000_000).optional(),
    source_bytes_b64: z.string().max(40_000_000).optional(),
    content_type: z.string().max(128).nullable().optional(),
    declared_format: BursarSourceFormat.nullable().optional(),
    byte_len: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((v) => v.source_text !== undefined || v.source_bytes_b64 !== undefined, {
    message: 'one of source_text or source_bytes_b64 is required',
  });
export type BursarParseOffer = z.infer<typeof bursarParseOfferSchema>;

// BullMQ queue for the event-triggered deterministic offer parse. bursar-api is the producer;
// the worker consumer registration (worker.ts cron) lands in M8, but the event-triggered enqueue
// from the ingest route is wired at M4.
export const BURSAR_PARSE_OFFER_QUEUE = 'bursar-parse-offer';
export interface BursarParseOfferJobData {
  organization_id: string;
  offer_id: string;
  /** Inline source text; absent when the worker must read the pinned Bin bytes itself. */
  source_text?: string;
}

/* ------------------------------------------------------------------ */
/*  Leveling (M5): the absence engine + coverage-collapse cluster     */
/* ------------------------------------------------------------------ */

// The six coverage verdicts (spec 6.1). Mirrors the bursar_offer_coverage_verdict_check DB
// constraint. `not_applicable` is a cleared, non-gap verdict; `absent` requires evidence.
export const BursarVerdict = z.enum([
  'covered',
  'partial',
  'excluded_explicit',
  'absent',
  'ambiguous',
  'not_applicable',
]);
export type BursarVerdict = z.infer<typeof BursarVerdict>;

// POST /requests/:id/level. Preflight + async start (202 + run id). `run_id` continues an existing
// `partial` run (spec 3.9's "levelled 6 of 8, continue" affordance) rather than minting a new one.
// `dry_run` returns only the cost preflight (estimated calls/tokens/wall-clock + would_exceed)
// without starting a run.
export const bursarLevelSchema = z
  .object({
    run_id: z.string().uuid().nullable().optional(),
    dry_run: z.boolean().optional(),
  })
  .partial();
export type BursarLevel = z.infer<typeof bursarLevelSchema>;

// POST /coverage/:id/override. A human adjudication overrides a coverage verdict (decided_by
// becomes 'human'). The reason is recorded; a delta amount may be supplied for a partial.
export const bursarCoverageOverrideSchema = z.object({
  verdict: BursarVerdict,
  reason: z.string().min(1).max(2000),
  delta_amount_minor: z.coerce.number().int().nullable().optional(),
});
export type BursarCoverageOverride = z.infer<typeof bursarCoverageOverrideSchema>;

// Internal async-start leveling transport. The org comes from the VALIDATED payload on this
// session-less route (spec 5.5); the worker forwards the same run_id until `done`.
export const bursarRunLevelingSchema = z.object({
  organization_id: z.string().uuid(),
  request_id: z.string().uuid(),
  run_id: z.string().uuid(),
  claimant: z.string().min(1).max(64),
});
export type BursarRunLeveling = z.infer<typeof bursarRunLevelingSchema>;

// BullMQ queue for async-start leveling. bursar-api is the producer; the worker consumer
// registration (worker.ts) lands in M8, mirroring derivation and parse.
export const BURSAR_LEVEL_QUEUE = 'bursar-level';
export interface BursarLevelJobData {
  organization_id: string;
  request_id: string;
  run_id: string;
}

/* ------------------------------------------------------------------ */
/*  Awards + baseline freeze (M7)                                     */
/* ------------------------------------------------------------------ */

// active | superseded | terminated (mirrors the bursar_awards status CHECK).
export const BursarAwardStatus = z.enum(['active', 'superseded', 'terminated']);
export type BursarAwardStatus = z.infer<typeof BursarAwardStatus>;

// The FROZEN baseline item kind CHECK (spec 7.1): what you got, what you knowingly excluded,
// and what was absent at award.
export const BursarBaselineKind = z.enum(['included', 'excluded_at_award', 'absent_at_award']);
export type BursarBaselineKind = z.infer<typeof BursarBaselineKind>;

// An ISO date (YYYY-MM-DD) or null. term_start / term_end are open-ended when null (spec 7.3).
const bursarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .nullable();

// POST /awards. Freezes the awarded offer's accepted tree into an immutable baseline in one
// org-scoped transaction (spec 7.1). vendor_id/currency default from the offer when omitted.
export const bursarAwardCreateSchema = z.object({
  request_id: z.string().uuid(),
  offer_id: z.string().uuid(),
  vendor_id: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
  term_start: bursarDate.optional(),
  term_end: bursarDate.optional(),
  auto_renew: z.boolean().default(false),
  renewal_notice_days: z.coerce.number().int().min(0).nullable().optional(),
  timezone: z.string().max(64).default('UTC'),
  contract_bin_asset_id: z.string().uuid().nullable().optional(),
});
export type BursarAwardCreate = z.infer<typeof bursarAwardCreateSchema>;

// POST /awards/:id/amend. Records a NEW award that supersedes the target, inheriting its
// request and chain root (spec 7.2). Every field is optional; omitted fields inherit the
// predecessor's value. offer_id may re-award a different offer.
export const bursarAwardAmendSchema = z
  .object({
    offer_id: z.string().uuid(),
    vendor_id: z.string().uuid().nullable(),
    currency: z.string().length(3),
    term_start: bursarDate,
    term_end: bursarDate,
    auto_renew: z.boolean(),
    renewal_notice_days: z.coerce.number().int().min(0).nullable(),
    timezone: z.string().max(64),
    contract_bin_asset_id: z.string().uuid().nullable(),
  })
  .partial();
export type BursarAwardAmend = z.infer<typeof bursarAwardAmendSchema>;

// POST /awards/:id/terminate. Flips an active award to `terminated` with an audit reason. The
// baseline stays immutable; termination is a header-only status change (spec 7).
export const bursarAwardTerminateSchema = z.object({
  reason: z.string().min(1).max(2000),
});
export type BursarAwardTerminate = z.infer<typeof bursarAwardTerminateSchema>;
