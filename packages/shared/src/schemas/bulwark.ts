import { z } from 'zod';

// Bulwark (AI contract-obligation monitor) schemas.
//
// This module OWNS the Bulwark contract, obligation, deadline, waiver-risk, vendor-tier,
// compliance-doc, and org-settings shapes shared between bulwark-api, the /bulwark SPA, and
// the bulwark_* MCP tools, plus the authoritative JSONB shapes (event_binding, deadline_rule,
// cited_span, notice_draft). See docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md
// sections 3.1 and 3.3.

/* ------------------------------------------------------------------ */
/*  Enums                                                             */
/* ------------------------------------------------------------------ */

export const BulwarkContractKind = z.enum([
  'subcontract',
  'sow',
  'msa',
  'grant_award',
  'lease',
  'amendment',
  'other',
]);
export type BulwarkContractKind = z.infer<typeof BulwarkContractKind>;

export const BulwarkContractStatus = z.enum([
  'draft',
  'extracting',
  'active',
  'amended',
  'expired',
  'terminated',
]);
export type BulwarkContractStatus = z.infer<typeof BulwarkContractStatus>;

export const BulwarkExtractionStatus = z.enum([
  'pending',
  'running',
  'extracted',
  'partial',
  'failed',
]);
export type BulwarkExtractionStatus = z.infer<typeof BulwarkExtractionStatus>;

// The obligation-type enum (D5/DI4). There is NO 'compliance' type; that path derives from
// flow_down obligations plus vendor tiers, not a type.
export const BulwarkObligationType = z.enum([
  'notice',
  'insurance',
  'indemnity',
  'payment',
  'retention',
  'flow_down',
  'renewal',
  'termination',
  'lien',
  'other',
]);
export type BulwarkObligationType = z.infer<typeof BulwarkObligationType>;

// Human-confirm-before-arm set (claim-or-money-waiving types): these never auto-arm on model
// confidence regardless of auto_confirm_threshold (D5).
export const BULWARK_HUMAN_CONFIRM_TYPES = [
  'notice',
  'lien',
  'retention',
  'indemnity',
  'payment',
] as const;

export const BulwarkReviewStatus = z.enum([
  'pending_review',
  'confirmed',
  'auto_confirmed',
  'rejected',
  'superseded',
]);
export type BulwarkReviewStatus = z.infer<typeof BulwarkReviewStatus>;

export const BulwarkDeadlineStatus = z.enum([
  'open',
  'discharged',
  'missed',
  'waived',
  'voided',
]);
export type BulwarkDeadlineStatus = z.infer<typeof BulwarkDeadlineStatus>;

export const BulwarkNoticeStatus = z.enum(['none', 'drafted', 'approved', 'sent', 'discarded']);
export type BulwarkNoticeStatus = z.infer<typeof BulwarkNoticeStatus>;

export const BulwarkAnchorSource = z.enum(['trigger_at', 'logged_at', 'manual', 'calendar']);
export type BulwarkAnchorSource = z.infer<typeof BulwarkAnchorSource>;

export const BulwarkRiskSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type BulwarkRiskSeverity = z.infer<typeof BulwarkRiskSeverity>;

export const BulwarkRiskReason = z.enum([
  'clock_running_out',
  'overdue',
  'unbound_obligation',
  'missing_compliance_doc',
]);
export type BulwarkRiskReason = z.infer<typeof BulwarkRiskReason>;

export const BulwarkRiskStatus = z.enum(['open', 'resolved', 'dismissed']);
export type BulwarkRiskStatus = z.infer<typeof BulwarkRiskStatus>;

export const BulwarkVendorChaseStatus = z.enum(['idle', 'chasing', 'compliant', 'blocked']);
export type BulwarkVendorChaseStatus = z.infer<typeof BulwarkVendorChaseStatus>;

export const BulwarkComplianceDocType = z.enum([
  'coi',
  'w9',
  'lien_waiver',
  'certified_payroll',
  'other',
]);
export type BulwarkComplianceDocType = z.infer<typeof BulwarkComplianceDocType>;

export const BulwarkCollectionStatus = z.enum(['missing', 'requested', 'collected']);
export type BulwarkCollectionStatus = z.infer<typeof BulwarkCollectionStatus>;

export const BulwarkValidityStatus = z.enum(['unknown', 'valid', 'expiring', 'expired']);
export type BulwarkValidityStatus = z.infer<typeof BulwarkValidityStatus>;

export const BulwarkComplianceChaseStatus = z.enum([
  'none',
  'drafted',
  'approved',
  'sent',
  'escalated',
]);
export type BulwarkComplianceChaseStatus = z.infer<typeof BulwarkComplianceChaseStatus>;

export const BulwarkIngestStatus = z.enum(['pending', 'processed', 'skipped']);
export type BulwarkIngestStatus = z.infer<typeof BulwarkIngestStatus>;

export const BulwarkExtractionRunStatus = z.enum(['running', 'succeeded', 'partial', 'failed']);
export type BulwarkExtractionRunStatus = z.infer<typeof BulwarkExtractionRunStatus>;

/* ------------------------------------------------------------------ */
/*  JSONB shapes (authoritative - spec 3.3)                            */
/* ------------------------------------------------------------------ */

// bulwark_obligations.event_binding. entity_filter is REQUIRED and non-empty for event-bound
// arming (STJ5); firing FAILS CLOSED on an absent path (S5). payload_path is allowlisted to
// id-typed fields (SM1).
export const bulwarkEntityFilterSchema = z.object({
  payload_path: z.string().min(1),
  equals_contract_field: z.string().min(1),
});
export type BulwarkEntityFilter = z.infer<typeof bulwarkEntityFilterSchema>;

export const bulwarkEventBindingSchema = z.object({
  source: z.string().min(1),
  event_type: z.string().min(1),
  entity_filter: bulwarkEntityFilterSchema.optional(),
  unbound: z.boolean().default(false),
});
export type BulwarkEventBinding = z.infer<typeof bulwarkEventBindingSchema>;

// bulwark_obligations.deadline_rule (THEME B + DI6 recurrence). recurrence absent = single
// occurrence; present with until:null is bounded by contract.expiry_date; both null is
// rejected at confirm (DK4).
export const BulwarkDeadlineUnit = z.enum(['calendar_days', 'business_days']);
export type BulwarkDeadlineUnit = z.infer<typeof BulwarkDeadlineUnit>;

export const BulwarkDeadlineFrom = z.enum([
  'trigger_event',
  'contract_effective_date',
  'contract_expiry_date',
]);
export type BulwarkDeadlineFrom = z.infer<typeof BulwarkDeadlineFrom>;

export const BulwarkRecurrenceInterval = z.enum(['annual', 'quarterly', 'monthly']);
export type BulwarkRecurrenceInterval = z.infer<typeof BulwarkRecurrenceInterval>;

export const bulwarkRecurrenceSchema = z.object({
  interval: BulwarkRecurrenceInterval,
  until: z.string().nullable(),
});
export type BulwarkRecurrence = z.infer<typeof bulwarkRecurrenceSchema>;

export const bulwarkDeadlineRuleSchema = z.object({
  offset_days: z.number().int(),
  unit: BulwarkDeadlineUnit,
  from: BulwarkDeadlineFrom,
  timezone: z.string().min(1),
  jurisdiction: z.string().optional(),
  holiday_calendar: z.string().optional(),
  roll_forward: z.boolean().default(true),
  grace_hours: z.number().int().default(0),
  recurrence: bulwarkRecurrenceSchema.optional(),
});
export type BulwarkDeadlineRule = z.infer<typeof bulwarkDeadlineRuleSchema>;

// bulwark_obligations.cited_span (D7). verified = source_text.slice(start,end) fuzzy-matched
// the quote, tied to source_doc_hash.
export const bulwarkCitedSpanSchema = z.object({
  page: z.number().int().nullable().optional(),
  section: z.string().nullable().optional(),
  quote: z.string().default(''),
  char_start: z.number().int().nullable().optional(),
  char_end: z.number().int().nullable().optional(),
  chunk_index: z.number().int().nullable().optional(),
  verified: z.boolean().default(false),
});
export type BulwarkCitedSpan = z.infer<typeof bulwarkCitedSpanSchema>;

// bulwark_notice_deadlines.notice_draft (THEME E). ONLY subject + body_markdown; recipient
// and attachments are deterministic, stamped by Bulwark at send, never in this shape.
export const bulwarkNoticeDraftSchema = z.object({
  subject: z.string().default(''),
  body_markdown: z.string().default(''),
});
export type BulwarkNoticeDraft = z.infer<typeof bulwarkNoticeDraftSchema>;

/* ------------------------------------------------------------------ */
/*  Entity read shapes                                                 */
/* ------------------------------------------------------------------ */

export const bulwarkContractSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),
  title: z.string(),
  contract_kind: BulwarkContractKind,
  supersedes_contract_id: z.string().uuid().nullable(),
  timezone: z.string(),
  jurisdiction: z.string().nullable(),
  bin_asset_id: z.string().uuid(),
  counterparty_type: z.string().nullable(),
  counterparty_id: z.string().uuid().nullable(),
  effective_date: z.string().nullable(),
  expiry_date: z.string().nullable(),
  status: BulwarkContractStatus,
  extraction_status: BulwarkExtractionStatus,
  extracted_at: z.string().nullable(),
  source_doc_hash: z.string().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkContract = z.infer<typeof bulwarkContractSchema>;

export const bulwarkObligationSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  clause_ref: z.string().nullable(),
  dedup_key: z.string(),
  supersedes_obligation_id: z.string().uuid().nullable(),
  obligation_type: BulwarkObligationType,
  title: z.string(),
  trigger_description: z.string().nullable(),
  event_binding: bulwarkEventBindingSchema,
  deadline_rule: bulwarkDeadlineRuleSchema.partial().or(z.record(z.unknown())),
  mandated_doc_types: z.array(BulwarkComplianceDocType).default([]),
  cited_span: bulwarkCitedSpanSchema,
  confidence: z.number().nullable(),
  review_status: BulwarkReviewStatus,
  is_armed: z.boolean(),
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string().nullable(),
  extraction_run_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkObligation = z.infer<typeof bulwarkObligationSchema>;

export const bulwarkNoticeDeadlineSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  obligation_id: z.string().uuid(),
  contract_id: z.string().uuid(),
  ingest_event_id: z.string().uuid().nullable(),
  triggering_event_id: z.string().uuid(),
  anchor_source: BulwarkAnchorSource,
  triggered_at: z.string(),
  logged_at: z.string().nullable(),
  resolved_timezone: z.string(),
  due_at: z.string(),
  status: BulwarkDeadlineStatus,
  notice_status: BulwarkNoticeStatus,
  notice_proposal_id: z.string().uuid().nullable(),
  // The notice_draft body is surfaced ONLY to bulwark.notice.draft holders (SK2); member-tier
  // deadline.read callers receive this null.
  notice_draft: bulwarkNoticeDraftSchema.nullable(),
  discharged_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkNoticeDeadline = z.infer<typeof bulwarkNoticeDeadlineSchema>;

export const bulwarkWaiverRiskSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  obligation_id: z.string().uuid(),
  deadline_id: z.string().uuid().nullable(),
  contract_id: z.string().uuid(),
  severity: BulwarkRiskSeverity,
  reason: BulwarkRiskReason,
  detail: z.record(z.unknown()).default({}),
  status: BulwarkRiskStatus,
  detected_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkWaiverRisk = z.infer<typeof bulwarkWaiverRiskSchema>;

export const bulwarkVendorTierSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  contract_id: z.string().uuid().nullable(),
  parent_tier_id: z.string().uuid().nullable(),
  vendor_type: z.string().nullable(),
  vendor_id: z.string().uuid().nullable(),
  tier_level: z.number().int(),
  required_doc_types: z.array(BulwarkComplianceDocType).default([]),
  chase_status: BulwarkVendorChaseStatus,
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkVendorTier = z.infer<typeof bulwarkVendorTierSchema>;

export const bulwarkComplianceDocSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  vendor_tier_id: z.string().uuid(),
  doc_type: BulwarkComplianceDocType,
  collection_status: BulwarkCollectionStatus,
  validity_status: BulwarkValidityStatus,
  chase_status: BulwarkComplianceChaseStatus,
  bin_asset_id: z.string().uuid().nullable(),
  effective_date: z.string().nullable(),
  expires_at: z.string().nullable(),
  chase_proposal_id: z.string().uuid().nullable(),
  blank_form_id: z.string().uuid().nullable(),
  last_chased_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BulwarkComplianceDoc = z.infer<typeof bulwarkComplianceDocSchema>;

/* ------------------------------------------------------------------ */
/*  Org settings                                                       */
/* ------------------------------------------------------------------ */

export const bulwarkRadarLeadTimesSchema = z.object({
  critical_hours: z.number().int().nonnegative(),
  high_hours: z.number().int().nonnegative(),
  medium_hours: z.number().int().nonnegative(),
});
export type BulwarkRadarLeadTimes = z.infer<typeof bulwarkRadarLeadTimesSchema>;

export const bulwarkOrgSettingsSchema = z.object({
  default_timezone: z.string(),
  auto_confirm_threshold: z.number().min(0).max(1),
  radar_lead_times: bulwarkRadarLeadTimesSchema,
  auto_draft_notices: z.boolean(),
  auto_draft_max_per_sweep: z.number().int().positive(),
  notice_llm_daily_cap: z.number().int().positive(),
  chase_cadence_days: z.number().int().positive(),
  coi_expiry_lead_days: z.number().int().positive(),
  discharged_deadline_retention_days: z.number().int().positive(),
  inbox_retention_days: z.number().int().positive(),
  llm_provider_id: z.string().uuid().nullable(),
  last_radar_sweep_at: z.string().nullable(),
});
export type BulwarkOrgSettings = z.infer<typeof bulwarkOrgSettingsSchema>;

// Update shape. inbox_retention_days >= discharged_deadline_retention_days is enforced at the
// settings service layer (STJ7), not here, because either field may be updated alone.
export const bulwarkUpdateSettingsSchema = z
  .object({
    default_timezone: z.string().min(1).optional(),
    auto_confirm_threshold: z.number().min(0).max(1).optional(),
    radar_lead_times: bulwarkRadarLeadTimesSchema.optional(),
    auto_draft_notices: z.boolean().optional(),
    auto_draft_max_per_sweep: z.number().int().positive().optional(),
    notice_llm_daily_cap: z.number().int().positive().optional(),
    chase_cadence_days: z.number().int().positive().optional(),
    coi_expiry_lead_days: z.number().int().positive().optional(),
    discharged_deadline_retention_days: z.number().int().positive().optional(),
    inbox_retention_days: z.number().int().positive().optional(),
    llm_provider_id: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field required' });

/* ------------------------------------------------------------------ */
/*  Pagination / list envelope                                         */
/* ------------------------------------------------------------------ */

export const bulwarkListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
});
