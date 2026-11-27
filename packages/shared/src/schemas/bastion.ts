import { z } from 'zod';
import { BEACON_SLUG } from '../suite-links.js';
import { boolQueryParam } from './common.js';

// Bastion (continuous compliance evidence) shared schemas.
//
// One source for the enumerations the bastion_* tables, bastion-api, the /bastion SPA and the
// bastion_* MCP tools share. M2 carries the data-model vocabulary (statuses, reason codes, gap
// kinds, ledger entry kinds) plus the machine-feed record contract and the probe result shape;
// later milestones add route bodies and queue contracts here, in the same change as the route.
// Every enum below mirrors a CHECK constraint in migrations 0274-0278 (the migration is the
// source of truth for the database; packages/shared/src/schemas/bastion.test.ts pins both).
//
// See docs/brainstorming/2026_11_25_20_03_APP_DESIGN_bastion.md sections 2.3, 3.1-3.5, 4.1.

// Boolean query parameters use boolQueryParam from ./common.ts (#251), the one suite-wide owner of
// "string flag -> boolean". It is still exported from @bigbluebam/shared (schemas/index.ts
// re-exports common.ts), so `import { boolQueryParam } from '@bigbluebam/shared'` is unchanged.

/* ------------------------------------------------------------------ */
/*  Frameworks and controls                                           */
/* ------------------------------------------------------------------ */

export const BastionFrameworkStatus = z.enum(['compiling', 'active', 'archived']);
export type BastionFrameworkStatus = z.infer<typeof BastionFrameworkStatus>;

export const BastionControlLifecycle = z.enum(['active', 'retired']);
export type BastionControlLifecycle = z.infer<typeof BastionControlLifecycle>;

/** bastion_org_settings.remediation_tasks (spec 4.1): create Bam tasks directly, or propose them. */
export const BastionRemediationTasks = z.enum(['create', 'propose']);
export type BastionRemediationTasks = z.infer<typeof BastionRemediationTasks>;

/** The STORED status of a control or the outcome of one snapshot (spec 3.2). */
export const BastionStoredStatus = z.enum(['pass', 'fail', 'unprovable']);
export type BastionStoredStatus = z.infer<typeof BastionStoredStatus>;

/**
 * The effective state every reader sees, from effectiveStatus() (spec 2.3, 3.2).
 * pass_with_exception is computed, never stored.
 */
export const BastionEffectiveState = z.enum(['pass', 'pass_with_exception', 'fail', 'unprovable']);
export type BastionEffectiveState = z.infer<typeof BastionEffectiveState>;

/** Worst-first ordering used to aggregate per-assertion states into a control state. */
export const BASTION_EFFECTIVE_STATE_SEVERITY: Record<BastionEffectiveState, number> = {
  fail: 3,
  unprovable: 2,
  pass_with_exception: 1,
  pass: 0,
};

/** Reasons stored on an `unprovable` control or snapshot (spec 3.2). */
export const BastionStoredUnprovableReason = z.enum([
  'not_yet_confirmed',
  'no_evidence_source',
  'source_not_connected',
  'manual_evidence_missing',
  'manual_evidence_expired',
  'insufficient_data',
  'probe_error',
]);
export type BastionStoredUnprovableReason = z.infer<typeof BastionStoredUnprovableReason>;

/** All unprovable reasons a reader can see: the stored ones plus the computed staleness. */
export const BastionUnprovableReason = z.enum([
  ...BastionStoredUnprovableReason.options,
  'evaluation_stale',
]);
export type BastionUnprovableReason = z.infer<typeof BastionUnprovableReason>;

export const BastionCoverageKind = z.enum([
  'native',
  'feed',
  'manual_file',
  'self_attested',
  'mixed',
  'none',
]);
export type BastionCoverageKind = z.infer<typeof BastionCoverageKind>;

export const BastionRequirementApplicability = z.enum(['applicable', 'not_applicable']);
export type BastionRequirementApplicability = z.infer<typeof BastionRequirementApplicability>;

export const BastionRequirementSource = z.enum(['crosswalk', 'admin']);
export type BastionRequirementSource = z.infer<typeof BastionRequirementSource>;

/* ------------------------------------------------------------------ */
/*  Assertions and the probe catalog                                  */
/* ------------------------------------------------------------------ */

export const BastionAssertionKind = z.enum(['probe', 'manual', 'feed']);
export type BastionAssertionKind = z.infer<typeof BastionAssertionKind>;

export const BastionAssertionProposedBy = z.enum(['library', 'compiler', 'human', 'agent']);
export type BastionAssertionProposedBy = z.infer<typeof BastionAssertionProposedBy>;

export const BastionAssertionReviewStatus = z.enum([
  'proposed',
  'confirmed',
  'rejected',
  'superseded',
]);
export type BastionAssertionReviewStatus = z.infer<typeof BastionAssertionReviewStatus>;

/**
 * The closed probe menu (spec 3.1). Each key has a hardened definer function
 * bastion_probe_<key with dots as underscores>_v<version> in migration 0279.
 */
export const BASTION_PROBE_KEYS = [
  'keys.max_age',
  'keys.unused_active',
  'access.departed_still_holding',
  'access.dormant_accounts',
  'access.privileged_roster',
  'auth.failed_login_spikes',
  'agents.policy_coverage',
  'agents.human_approval',
  'change.merge_reviewed',
  'change.merge_traceable',
  'ops.backup_fresh',
  'ops.restore_tested',
  'logging.retention_floor',
  'logging.audit_trail_alive',
  'automation.failure_rate',
  'policy.attested',
  'policy.current',
  'platform.superuser_access',
  'vendors.critical_have_award',
  'feed.fresh',
] as const;
export const BastionProbeKey = z.enum(BASTION_PROBE_KEYS);
export type BastionProbeKey = z.infer<typeof BastionProbeKey>;

/** The SQL function name for a probe version: `keys.max_age` v1 -> bastion_probe_keys_max_age_v1. */
export function bastionProbeFunctionName(key: BastionProbeKey, version: number): string {
  return `bastion_probe_${key.replace(/\./g, '_')}_v${version}`;
}

/** A cited reference in hashed evidence: never a label (labels live in bastion_personal_data). */
export const bastionCitedRefSchema = z
  .object({
    entity_type: z.string().min(1).max(48),
    entity_id: z.string().uuid(),
  })
  .strict();
export type BastionCitedRef = z.infer<typeof bastionCitedRefSchema>;

export const BASTION_MAX_CITED_REFS = 200;

/** What every bastion_probe_*_v<n> function returns (migration 0279 contract). */
export const bastionProbeResultSchema = z.object({
  probe_key: BastionProbeKey,
  probe_version: z.number().int().positive(),
  as_of: z.string(),
  summary: z.record(z.unknown()),
  cited_refs: z.array(bastionCitedRefSchema).max(BASTION_MAX_CITED_REFS),
  cited_count: z.number().int().nonnegative(),
  overflow_count: z.number().int().nonnegative(),
  population_checked: z.array(z.string()).optional(),
  population_unlisted: z.array(z.string()).optional(),
  population_missing: z.array(z.string()).optional(),
});
export type BastionProbeResult = z.infer<typeof bastionProbeResultSchema>;

/* ------------------------------------------------------------------ */
/*  Evaluation runs and compile runs                                  */
/* ------------------------------------------------------------------ */

export const BastionRunStatus = z.enum(['queued', 'running', 'succeeded', 'partial', 'failed']);
export type BastionRunStatus = z.infer<typeof BastionRunStatus>;

export const BastionEvaluationTrigger = z.enum(['nightly', 'manual', 'agent']);
export type BastionEvaluationTrigger = z.infer<typeof BastionEvaluationTrigger>;

export const BastionEvaluationScope = z.enum(['all', 'control']);
export type BastionEvaluationScope = z.infer<typeof BastionEvaluationScope>;

/* ------------------------------------------------------------------ */
/*  Manual evidence                                                   */
/* ------------------------------------------------------------------ */

export const BastionManualEvidenceKind = z.enum(['file', 'attestation_statement']);
export type BastionManualEvidenceKind = z.infer<typeof BastionManualEvidenceKind>;

export const BastionManualEvidenceStatus = z.enum([
  'pending_scan',
  'active',
  'superseded',
  'withdrawn',
  'blocked',
]);
export type BastionManualEvidenceStatus = z.infer<typeof BastionManualEvidenceStatus>;

/** Why a manual-evidence item is blocked (spec 3.3 scan-state mapping). */
export const BastionManualEvidenceBlockedReason = z.enum([
  'infected',
  'scan_failed',
  'changed_before_scan',
]);
export type BastionManualEvidenceBlockedReason = z.infer<typeof BastionManualEvidenceBlockedReason>;

export const BastionEvidenceSensitivity = z.enum(['standard', 'restricted']);
export type BastionEvidenceSensitivity = z.infer<typeof BastionEvidenceSensitivity>;

export const BastionScanLabel = z.enum(['clean', 'not_scanned']);
export type BastionScanLabel = z.infer<typeof BastionScanLabel>;

export const BastionReviewVerdict = z.enum(['pending', 'accepted', 'shows_exception']);
export type BastionReviewVerdict = z.infer<typeof BastionReviewVerdict>;

/* ------------------------------------------------------------------ */
/*  Machine feeds                                                     */
/* ------------------------------------------------------------------ */

export const BastionFeedSourceKind = z.enum(['api_push', 'bolt_event']);
export type BastionFeedSourceKind = z.infer<typeof BastionFeedSourceKind>;

export const BastionFeedStatus = z.enum(['active', 'paused', 'retired']);
export type BastionFeedStatus = z.infer<typeof BastionFeedStatus>;

export const BastionFeedKeyStatus = z.enum(['active', 'grace', 'revoked']);
export type BastionFeedKeyStatus = z.infer<typeof BastionFeedKeyStatus>;

/** Per-batch limits for POST /feeds/:feed_key/records (spec 3.5). */
export const BASTION_FEED_MAX_RECORDS_PER_BATCH = 500;
export const BASTION_FEED_MAX_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * One record pushed by a machine feed (spec 3.5). subject and attributes are personal data:
 * they are stored in bastion_personal_data and only their HMAC reaches the immutable row.
 */
export const bastionFeedRecordSchema = z
  .object({
    idempotency_key: z.string().min(1).max(256),
    occurred_at: z.string().datetime({ offset: true }),
    subject: z.string().max(512).optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .strict();
export type BastionFeedRecord = z.infer<typeof bastionFeedRecordSchema>;

export const bastionFeedBatchSchema = z
  .object({
    records: z.array(bastionFeedRecordSchema).min(1).max(BASTION_FEED_MAX_RECORDS_PER_BATCH),
  })
  .strict();
export type BastionFeedBatch = z.infer<typeof bastionFeedBatchSchema>;

/* ------------------------------------------------------------------ */
/*  Personal data, inbox, outbox                                      */
/* ------------------------------------------------------------------ */

export const BastionPersonalDataHolderKind = z.enum([
  'snapshot',
  'manual_evidence',
  'feed_record',
  'attestation',
  'exception',
]);
export type BastionPersonalDataHolderKind = z.infer<typeof BastionPersonalDataHolderKind>;

/** bastion_personal_data.data is capped at 16 KB (CHECK in migration 0275). */
export const BASTION_PERSONAL_DATA_MAX_BYTES = 16 * 1024;

export const BastionIngestStatus = z.enum(['pending', 'processing', 'done', 'failed', 'dead']);
export type BastionIngestStatus = z.infer<typeof BastionIngestStatus>;

export const BastionOutboxKind = z.enum([
  'bolt_event',
  'bam_task_upsert',
  'bam_task_comment',
  'proposal_close',
  'seal_object',
]);
export type BastionOutboxKind = z.infer<typeof BastionOutboxKind>;

/** `superseded` (0283, #189): a re-driven dead row whose key already delivered a newer row. */
export const BastionOutboxStatus = z.enum(['pending', 'delivered', 'dead', 'superseded']);
export type BastionOutboxStatus = z.infer<typeof BastionOutboxStatus>;

/* ------------------------------------------------------------------ */
/*  Ledger, seals, restores                                           */
/* ------------------------------------------------------------------ */

export const BastionLedgerEntryKind = z.enum([
  'snapshot',
  'manual_evidence',
  'withdrawal',
  'feed_record',
  'attestation',
  'exception',
  'redaction',
  'restore',
]);
export type BastionLedgerEntryKind = z.infer<typeof BastionLedgerEntryKind>;

/** prev_entry_hash of the first entry in an org's ledger (spec 3.4). */
export const BASTION_LEDGER_GENESIS_HASH = '0'.repeat(64);

export const BastionRestoreStatus = z.enum(['pending_ack', 'acknowledged', 'unmatched']);
export type BastionRestoreStatus = z.infer<typeof BastionRestoreStatus>;

export const BastionRestoreResolution = z.enum(['restore_acknowledged', 'continue_unexplained']);
export type BastionRestoreResolution = z.infer<typeof BastionRestoreResolution>;

/** Verification outcomes for one ledger entry (spec 3.4). */
export const BastionVerificationResult = z.enum([
  'intact',
  'hash_mismatch',
  'object_missing',
  'redacted',
  'pd_mismatch',
  'key_changed',
]);
export type BastionVerificationResult = z.infer<typeof BastionVerificationResult>;

/* ------------------------------------------------------------------ */
/*  Gaps, fixes, drift, exceptions                                    */
/* ------------------------------------------------------------------ */

/** The 12 stored gap kinds (spec 2.3). `stale` is org-level and derived at read time. */
export const BastionGapKind = z.enum([
  'failing',
  'no_source',
  'manual_expired',
  'not_connected',
  'manual_missing',
  'population_drift',
  'check_broken',
  'insufficient_data',
  'population_review',
  'not_assessed',
  'manual_expiring',
  'attested_only',
]);
export type BastionGapKind = z.infer<typeof BastionGapKind>;

export const BastionGapStatus = z.enum(['open', 'proposed', 'resolved', 'dismissed']);
export type BastionGapStatus = z.infer<typeof BastionGapStatus>;

export const BastionFixTemplate = z.enum([
  'confirm_check',
  'evidence_request',
  'policy_draft',
  'bolt_rule',
  'connect_source',
  'config_change',
  'process_change',
]);
export type BastionFixTemplate = z.infer<typeof BastionFixTemplate>;

/** Fix-template costs (spec 2.3). population_review overrides confirm_check to cost 2. */
export const BASTION_FIX_TEMPLATE_COST: Record<BastionFixTemplate, number> = {
  confirm_check: 1,
  config_change: 1,
  connect_source: 2,
  bolt_rule: 2,
  evidence_request: 2,
  policy_draft: 3,
  process_change: 5,
};

/**
 * Fixed gap severities (spec 2.3). manual_expiring is computed from the days left
 * (0.50 x (1 - days_left / warn_window)), so it has no fixed entry.
 */
export const BASTION_GAP_SEVERITY: Partial<Record<BastionGapKind, number>> = {
  failing: 1.0,
  no_source: 0.9,
  manual_expired: 0.85,
  not_connected: 0.8,
  manual_missing: 0.8,
  population_drift: 0.7,
  check_broken: 0.6,
  insufficient_data: 0.4,
  population_review: 0.4,
  not_assessed: 0.3,
  attested_only: 0.54,
};

export const BastionFixDraftStatus = z.enum([
  'proposed',
  'approved',
  'rejected',
  'expired',
  'applied',
  'decision_rejected',
]);
export type BastionFixDraftStatus = z.infer<typeof BastionFixDraftStatus>;

export const BastionDriftTaskStatus = z.enum([
  'pending',
  'created',
  'reopened',
  'updated',
  'no_project',
  'proposed',
  /** The Compliance project was deleted or has no open phase; re-driven once fixed (#229, 0285). */
  'project_unavailable',
]);
export type BastionDriftTaskStatus = z.infer<typeof BastionDriftTaskStatus>;

export const BastionExceptionScope = z.enum(['entity', 'assertion']);
export type BastionExceptionScope = z.infer<typeof BastionExceptionScope>;

export const BastionExceptionStatus = z.enum(['proposed', 'active', 'expired', 'rejected']);
export type BastionExceptionStatus = z.infer<typeof BastionExceptionStatus>;

/** Maximum exception lifetimes in days (CHECK in migration 0276). */
export const BASTION_EXCEPTION_MAX_DAYS: Record<BastionExceptionScope, number> = {
  entity: 365,
  assertion: 90,
};

/* ------------------------------------------------------------------ */
/*  Policies and attestations                                         */
/* ------------------------------------------------------------------ */

export const BastionPolicyStatus = z.enum(['active', 'retired']);
export type BastionPolicyStatus = z.infer<typeof BastionPolicyStatus>;

/**
 * A policy's linked Beacon article as Bastion sees it (#244, #285): only `current` can be read and
 * acknowledged. One union for bastion-api, the SPA and the MCP tools.
 */
export const BastionPolicyArticleState = z.enum(['current', 'missing', 'retired', 'expired']);
export type BastionPolicyArticleState = z.infer<typeof BastionPolicyArticleState>;

export const bastionPolicyAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('users'), user_ids: z.array(z.string().uuid()).min(1) }).strict(),
]);
export type BastionPolicyAudience = z.infer<typeof bastionPolicyAudienceSchema>;

/* ------------------------------------------------------------------ */
/*  Questionnaires                                                    */
/* ------------------------------------------------------------------ */

export const BastionQuestionnaireFormat = z.enum(['xlsx', 'csv']);
export type BastionQuestionnaireFormat = z.infer<typeof BastionQuestionnaireFormat>;

export const BastionQuestionnaireStatus = z.enum([
  'uploaded',
  'mapping',
  'answering',
  'in_review',
  'approved',
  'exported',
  'failed',
]);
export type BastionQuestionnaireStatus = z.infer<typeof BastionQuestionnaireStatus>;

export const BastionAnswerKind = z.enum(['yes_no', 'text', 'yes_no_text']);
export type BastionAnswerKind = z.infer<typeof BastionAnswerKind>;

export const BastionConfidenceBand = z.enum(['high', 'medium', 'low']);
export type BastionConfidenceBand = z.infer<typeof BastionConfidenceBand>;

export const BastionItemReviewStatus = z.enum(['pending', 'accepted', 'edited', 'needs_owner']);
export type BastionItemReviewStatus = z.infer<typeof BastionItemReviewStatus>;

/* ------------------------------------------------------------------ */
/*  Sharing                                                           */
/* ------------------------------------------------------------------ */

export const BastionAuditorViewKind = z.enum([
  'overview',
  'control',
  'evidence',
  'download',
  'request',
]);
export type BastionAuditorViewKind = z.infer<typeof BastionAuditorViewKind>;

export const BastionAuditorRequestStatus = z.enum(['open', 'answered', 'closed']);
export type BastionAuditorRequestStatus = z.infer<typeof BastionAuditorRequestStatus>;

/** Hard cap on an auditor room's lifetime in days (CHECK in migration 0278). */
export const BASTION_AUDITOR_ROOM_MAX_DAYS = 180;

export const BastionExportStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'expired']);
export type BastionExportStatus = z.infer<typeof BastionExportStatus>;

/* ------------------------------------------------------------------ */
/*  M3 route bodies: frameworks, controls, assertions, setup          */
/* ------------------------------------------------------------------ */

/** The built-in framework templates shipped in apps/bastion-api/src/library (spec 2.1). */
export const BASTION_TEMPLATE_KEYS = ['soc2', 'iso27001'] as const;
export const BastionTemplateKey = z.enum(BASTION_TEMPLATE_KEYS);
export type BastionTemplateKey = z.infer<typeof BastionTemplateKey>;

/**
 * Which connected set a population probe's expected_population is drawn from. The
 * deterministic compile proposes the connected set; a human confirms "This is the complete list".
 */
export const BastionPopulationKind = z.enum(['github_repos', 'blip_apps']);
export type BastionPopulationKind = z.infer<typeof BastionPopulationKind>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31');

/** POST /frameworks: adopt a built-in framework. */
export const bastionAdoptFrameworkSchema = z
  .object({
    template_key: BastionTemplateKey,
    audit_target_date: isoDate.nullable().optional(),
    period_start: isoDate.nullable().optional(),
    period_end: isoDate.nullable().optional(),
  })
  .strict();
export type BastionAdoptFramework = z.infer<typeof bastionAdoptFrameworkSchema>;

/** PATCH /frameworks/:id. */
export const bastionFrameworkUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    audit_target_date: isoDate.nullable().optional(),
    period_start: isoDate.nullable().optional(),
    period_end: isoDate.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionFrameworkUpdate = z.infer<typeof bastionFrameworkUpdateSchema>;

/** POST /frameworks/:id/archive. Destructive (retires single-framework controls): needs confirm. */
export const bastionArchiveFrameworkSchema = z.object({ confirm: z.literal(true) }).strict();
export type BastionArchiveFramework = z.infer<typeof bastionArchiveFrameworkSchema>;

/**
 * POST /frameworks/:id/compile. Same contract since M3: 202 with the run. M7: when an AI provider
 * resolves for the org and `use_ai` is not false, the run is queued and the worker drives the
 * LLM-tailored compile (spec 2.1 step 2, 7.3); otherwise the deterministic compile (step 5) runs
 * in the request and the 202 carries the finished run. Poll GET /frameworks/:id/compile-runs.
 */
export const bastionCompileFrameworkSchema = z
  .object({
    /** false forces the library's suggestions verbatim (the deterministic fallback). Default true. */
    use_ai: z.boolean().optional(),
  })
  .strict();
export type BastionCompileFramework = z.infer<typeof bastionCompileFrameworkSchema>;

/** GET /frameworks/:id/compile-runs: newest first, cursor-paginated (next_cursor + has_more). */
export const bastionCompileRunListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type BastionCompileRunListQuery = z.infer<typeof bastionCompileRunListQuerySchema>;

/** PATCH /control-requirements/:id (one link's Statement of Applicability decision). */
export const bastionRequirementApplicabilitySchema = z
  .object({
    applicability: BastionRequirementApplicability,
    not_applicable_reason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => b.applicability === 'applicable' || (b.not_applicable_reason ?? '').trim().length > 0, {
    message: 'Say why this does not apply',
    path: ['not_applicable_reason'],
  });
export type BastionRequirementApplicabilityUpdate =z.infer<typeof bastionRequirementApplicabilitySchema>;

/** POST /frameworks/:id/applicability: decide several requirements (every link of each ref code). */
export const bastionBulkApplicabilitySchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            ref_code: z.string().trim().min(1).max(64),
            applicability: BastionRequirementApplicability,
            not_applicable_reason: z.string().trim().max(2000).nullable().optional(),
          })
          .strict()
          .refine(
            (d) => d.applicability === 'applicable' || (d.not_applicable_reason ?? '').trim().length > 0,
            { message: 'Say why this does not apply', path: ['not_applicable_reason'] },
          ),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type BastionBulkApplicability = z.infer<typeof bastionBulkApplicabilitySchema>;

const controlSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,62}$/, 'Use lower-case letters, digits, dots, dashes or underscores');

/** POST /controls: an org-authored custom control (`control_key = custom:<slug>`). */
export const bastionControlCreateSchema = z
  .object({
    slug: controlSlug,
    title: z.string().trim().min(1).max(512),
    plain_summary: z.string().trim().max(4000).nullable().optional(),
    category: z.string().trim().max(64).nullable().optional(),
    risk_weight: z.number().int().min(1).max(5).optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    requirement_links: z
      .array(z.object({ framework_id: z.string().uuid(), ref_code: z.string().trim().min(1).max(64) }).strict())
      .max(50)
      .optional(),
  })
  .strict();
export type BastionControlCreate = z.infer<typeof bastionControlCreateSchema>;

/** PATCH /controls/:id. */
export const bastionControlUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    plain_summary: z.string().trim().max(4000).nullable().optional(),
    category: z.string().trim().max(64).nullable().optional(),
    risk_weight: z.number().int().min(1).max(5).optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionControlUpdate = z.infer<typeof bastionControlUpdateSchema>;

/** What a manual assertion asks a person to provide (bastion_assertions.manual_evidence_spec). */
export const bastionManualEvidenceSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    description: z.string().trim().max(2000),
    kind: BastionManualEvidenceKind,
    /** How often fresh evidence is needed, in days. */
    cadence_days: z.number().int().min(1).max(1095),
  })
  .strict();
export type BastionManualEvidenceSpec = z.infer<typeof bastionManualEvidenceSpecSchema>;

/**
 * Probe parameters at the API boundary. The probe's own schema (apps/bastion-api/src/library/
 * probe-catalog.ts) validates the keys server-side; unknown probe keys or out-of-range values are
 * refused (spec 2.1 step 3).
 */
export const bastionProbeParamsSchema = z.record(z.unknown());

const plainStatement = z.string().trim().min(1).max(2000);

/** POST /controls/:id/assertions. */
export const bastionAssertionProposeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('probe'),
      probe_key: BastionProbeKey,
      params: bastionProbeParamsSchema.optional(),
      plain_statement: plainStatement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('manual'),
      manual_evidence_spec: bastionManualEvidenceSpecSchema,
      plain_statement: plainStatement,
    })
    .strict(),
  z
    .object({
      kind: z.literal('feed'),
      feed_id: z.string().uuid(),
      plain_statement: plainStatement,
    })
    .strict(),
]);
export type BastionAssertionPropose = z.infer<typeof bastionAssertionProposeSchema>;

/**
 * POST /assertions/:id/revise: files a superseding proposed assertion. Only the fields given
 * change; the kind and the probe stay. `expected_population` replaces the population (adding a
 * repository that was missing from the connected set, spec 2.1 step 5).
 */
export const bastionAssertionReviseSchema = z
  .object({
    plain_statement: plainStatement.optional(),
    params: bastionProbeParamsSchema.optional(),
    expected_population: z.array(z.string().trim().min(1).max(256)).max(500).optional(),
    manual_evidence_spec: bastionManualEvidenceSpecSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionAssertionRevise = z.infer<typeof bastionAssertionReviseSchema>;

/**
 * POST /assertions/:id/confirm. A population assertion needs `population_confirmed: true`, the
 * "This is the complete list" confirmation (stored as population_confirmed_at/by in the params).
 */
export const bastionAssertionConfirmSchema = z
  .object({ population_confirmed: z.boolean().optional() })
  .strict();
export type BastionAssertionConfirm = z.infer<typeof bastionAssertionConfirmSchema>;

/** POST /assertions/:id/reject. */
export const bastionAssertionRejectSchema = z
  .object({ reason: z.string().trim().max(2000).optional() })
  .strict();
export type BastionAssertionReject = z.infer<typeof bastionAssertionRejectSchema>;

/** The ten plain company-profile questions of the setup interview (spec 2.1 step 1). */
export const bastionCompanyProfileSchema = z
  .object({
    company_size: z.enum(['1-10', '11-50', '51-200', '201+']).optional(),
    work_style: z.enum(['office', 'remote', 'mixed']).optional(),
    has_own_premises: z.boolean().optional(),
    builds_software: z.boolean().optional(),
    uses_github: z.boolean().optional(),
    stores_customer_personal_data: z.boolean().optional(),
    takes_card_payments: z.boolean().optional(),
    uses_cloud_hosting: z.boolean().optional(),
    has_contractors: z.boolean().optional(),
    issues_company_laptops: z.boolean().optional(),
  })
  .strict();
export type BastionCompanyProfile = z.infer<typeof bastionCompanyProfileSchema>;
export const BASTION_COMPANY_PROFILE_QUESTION_COUNT = 10;

/** POST /setup/compliance-project: the required Compliance project (spec 2.5). */
export const bastionSetupComplianceProjectSchema = z
  .object({ project_id: z.string().uuid() })
  .strict();
export type BastionSetupComplianceProject = z.infer<typeof bastionSetupComplianceProjectSchema>;

/** List filters shared by GET /controls and the bastion_list_controls tool. */
export const bastionControlListQuerySchema = z
  .object({
    framework_id: z.string().uuid().optional(),
    lifecycle: BastionControlLifecycle.optional(),
    setup: z.enum(['set_up', 'not_set_up', 'not_applicable']).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();
export type BastionControlListQuery = z.infer<typeof bastionControlListQuerySchema>;

/** Whether a control has a confirmed way to be checked (spec 2.3 "Not set up yet"). */
export const BastionSetupState = z.enum(['set_up', 'not_set_up', 'not_applicable']);
export type BastionSetupState = z.infer<typeof BastionSetupState>;

/* ------------------------------------------------------------------ */
/*  M4: evidence engine (evaluations, ledger, outbox, events, queues) */
/* ------------------------------------------------------------------ */

/**
 * Every Bolt event Bastion publishes (spec 8.1), source `bastion`. A unit test in bolt-api
 * asserts this tuple equals the `bastionEvents` set in event-catalog.ts, and
 * scripts/check-bolt-catalog.mjs treats `enqueueBastionEvent('<literal>', ...)` as a `bastion`
 * publisher, so a name used in code but missing from the catalog fails CI.
 */
export const BASTION_EVENT_TYPES = [
  'framework.adopted',
  'assertions.compiled',
  'evaluation.completed',
  'evaluation.missed',
  'control.drifted',
  'control.recovered',
  'evidence.uploaded',
  'evidence.expiring',
  'evidence.expired',
  'evidence.integrity_failed',
  'evidence.redacted',
  'ledger.sealed',
  'ledger.restore_detected',
  'ledger.restored',
  'gap.fix_proposed',
  'exception.proposed',
  'exception.approved',
  'exception.expired',
  'attestation.overdue',
  'questionnaire.drafted',
  'questionnaire.approved',
  'auditor_room.created',
  'auditor_room.revoked',
  'readiness.weekly',
] as const;
export type BastionEventType = (typeof BASTION_EVENT_TYPES)[number];

/** POST /evaluations (spec 5.1 row 22): a full run, or one control's run when control_id is set. */
export const bastionRunEvaluationSchema = z
  .object({
    control_id: z.string().uuid().optional(),
  })
  .strict();
export type BastionRunEvaluation = z.infer<typeof bastionRunEvaluationSchema>;

/** GET /evaluations filters (spec 5.1 row 23). */
export const bastionEvaluationListQuerySchema = z
  .object({
    status: BastionRunStatus.optional(),
    /** next_cursor from the previous page (issue #204). */
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type BastionEvaluationListQuery = z.infer<typeof bastionEvaluationListQuerySchema>;

/** GET /controls/:id/evidence (spec 5.1 row 25). */
export const bastionEvidenceListQuerySchema = z
  .object({
    assertion_id: z.string().uuid().optional(),
    /** next_cursor from the previous page (issue #204). */
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type BastionEvidenceListQuery = z.infer<typeof bastionEvidenceListQuerySchema>;

/** GET /ledger/seals (spec 5.1 row 29), newest seal_date first, cursor-paginated (issue #204). */
export const bastionSealListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(400).default(90),
  })
  .strict();
export type BastionSealListQuery = z.infer<typeof bastionSealListQuerySchema>;

/** GET /ledger/restores (spec 5.1 row 30), newest first, cursor-paginated (issue #204). */
export const bastionRestoreListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BastionRestoreListQuery = z.infer<typeof bastionRestoreListQuerySchema>;

/**
 * POST /ledger/restores/:id/acknowledge (spec 3.4 points 4 and 5, row 31). `confirm` is the
 * confirm gate; `continue_unexplained` is the only resolution allowed for an `unmatched` row.
 */
export const bastionRestoreAcknowledgeSchema = z
  .object({
    resolution: BastionRestoreResolution,
    confirm: z.literal(true),
  })
  .strict();
export type BastionRestoreAcknowledge = z.infer<typeof bastionRestoreAcknowledgeSchema>;

/** The engines bastion-api runs for the worker behind POST /v1/internal/engines/:name (row 106). */
export const BASTION_ENGINE_NAMES = [
  'evaluate-tick',
  'evaluate-run',
  'outbox-drain',
  'ledger-seal',
  'ledger-verify',
  'run-reaper',
  'evaluation-missed',
  'weekly-readiness',
  'retention',
  // M5
  'evidence-ingest',
  'evidence-expiry',
  // M6
  'gap-rank',
  'proposal-reconcile',
  // M7
  'compile',
  'attestation-nudge',
  // M8
  'questionnaire-autofill',
  // M9: the object sweep (intents), the off-site mirror after each database backup, the
  // personal-data commitment checks the packet job asks for (the HMAC key stays in bastion-api),
  // and the packet job's claim / progress / finish calls.
  'object-sweep',
  'mirror-objects',
  'verify-commitments',
  'export-packet',
] as const;
export const BastionEngineName = z.enum(BASTION_ENGINE_NAMES);
export type BastionEngineName = z.infer<typeof BastionEngineName>;

/** Body of the evaluate-run engine: one slice of one run, fenced on the claimant. */
export const bastionEvaluateRunEngineSchema = z
  .object({
    organization_id: z.string().uuid(),
    run_id: z.string().uuid(),
    claimant: z.string().min(1).max(128),
  })
  .strict();
export type BastionEvaluateRunEngine = z.infer<typeof bastionEvaluateRunEngineSchema>;

/** Body of every scheduled engine: optionally narrowed to one org (tests, operators). */
export const bastionSweepEngineSchema = z
  .object({
    organization_id: z.string().uuid().optional(),
    /**
     * Which scheduled pass this call belongs to (the worker's job id, the same across that job's
     * retries). gap-rank ties its resume cursor to it, so a cursor left by another pass is never
     * resumed and no org is skipped for the day (#256). Engines without a cursor ignore it.
     */
    pass_id: z.string().min(1).max(200).optional(),
  })
  .strict();
export type BastionSweepEngine = z.infer<typeof bastionSweepEngineSchema>;

/** POST /v1/internal/events (row 105): what bolt-api's bastion dispatch hook forwards. */
export const bastionInternalEventSchema = z
  .object({
    organization_id: z.string().uuid(),
    event: z.string().min(1).max(128),
    source: z.string().min(1).max(32),
    event_id: z.string().min(1).max(200).nullable().optional(),
    payload: z.record(z.unknown()).default({}),
  })
  .strict();
export type BastionInternalEvent = z.infer<typeof bastionInternalEventSchema>;

/**
 * Whether a forwarded event is one Bastion consumes, on payload grounds (issue #206). Bastion
 * reads platform `proposal.decided` only for its OWN proposals (proposed_action `bastion.*`,
 * spec 2.4 / 2.8); every other event passes (feeds are gated by their bindings). Used by
 * bolt-api's dispatch hook (do not forward) and by bastion-api's inbox (do not store), so the
 * rule lives in one place.
 */
export function bastionConsumesEvent(source: string, eventType: string, payload: Record<string, unknown> | null | undefined): boolean {
  if (source === 'platform' && eventType === 'proposal.decided') {
    const proposal = (payload?.proposal ?? null) as { proposed_action?: unknown } | null;
    return typeof proposal?.proposed_action === 'string' && proposal.proposed_action.startsWith('bastion.');
  }
  return true;
}

/** Worker queues (spec 7). bastion-api produces evaluate-run; the rest are scheduled sweeps. */
export const BASTION_EVALUATE_TICK_QUEUE = 'bastion-evaluate-tick';
export const BASTION_EVALUATE_RUN_QUEUE = 'bastion-evaluate-run';
export const BASTION_OUTBOX_DRAIN_QUEUE = 'bastion-outbox-drain';
export const BASTION_LEDGER_SEAL_QUEUE = 'bastion-ledger-seal';
export const BASTION_LEDGER_VERIFY_QUEUE = 'bastion-ledger-verify';
export const BASTION_RUN_REAPER_QUEUE = 'bastion-run-reaper';
export const BASTION_EVALUATION_MISSED_QUEUE = 'bastion-evaluation-missed';
export const BASTION_WEEKLY_READINESS_QUEUE = 'bastion-weekly-readiness';
export const BASTION_RETENTION_QUEUE = 'bastion-retention';

/** M5 (spec 7): pending-scan retries and Bolt-event feeds; expiring evidence. */
export const BASTION_EVIDENCE_INGEST_QUEUE = 'bastion-evidence-ingest';
export const BASTION_EVIDENCE_EXPIRY_QUEUE = 'bastion-evidence-expiry';

/** M6 (spec 7): stored gap ranking (after each run and daily) and proposal reconciliation. */
export const BASTION_GAP_RANK_QUEUE = 'bastion-gap-rank';
export const BASTION_PROPOSAL_RECONCILE_QUEUE = 'bastion-proposal-reconcile';

/** One evaluation run to drive. resume_count goes into the jobId (spec 7.3). */
export interface BastionEvaluateRunJobData {
  organization_id: string;
  run_id: string;
  resume_count: number;
  /**
   * Set only on the worker's own poll-cap handover: the claimant the predecessor job drove the
   * run as. The successor drives under the same claimant, so the live claim transfers to it at
   * once instead of stranding the run until the lease expires (issue #201).
   */
  claimant?: string;
}

/** Scheduled sweep jobs carry nothing (or one org for an operator re-run). */
export interface BastionSweepJobData {
  organization_id?: string;
}

/**
 * The jobId for an evaluate-run job, so a re-enqueue after a release (resume_count + 1) is never
 * deduplicated against an earlier completed job still kept by removeOnComplete (spec 7.3).
 * The spec writes `run.id + ':' + resume_count`; BullMQ 5 rejects a custom id with a single
 * colon ("Custom Id cannot contain :"), so the separator is `-r`. `generation` > 0 marks the
 * job's own re-enqueue after MAX_POLLS while the run is still live.
 */
export function bastionEvaluateRunJobId(runId: string, resumeCount: number, generation = 0): string {
  return generation > 0 ? `${runId}-r${resumeCount}-g${generation}` : `${runId}-r${resumeCount}`;
}

/*
 * Engine RESPONSE contracts (issue #205). bastion-api's engines route builds these and the
 * worker safeParses them, so a rename on either side fails loudly instead of type-checking
 * against a hand-copied interface (e.g. a job id built from `resume_count: undefined`).
 */

/** 200 `data` of POST /internal/engines/evaluate-run: one slice of one run. */
export const bastionEvaluateRunSliceSchema = z.object({
  done: z.boolean(),
  status: BastionRunStatus,
  partial_reason: z.string().nullable().optional(),
  assertions_done: z.number().int().nonnegative(),
  assertions_total: z.number().int().nonnegative(),
  controls_done: z.number().int().nonnegative(),
  controls_total: z.number().int().nonnegative(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  unprovable: z.number().int().nonnegative(),
  slice_ms: z.number().nonnegative(),
  /** Set when the slice stopped on a transient wait; the worker backs off before the next one. */
  waiting: z.enum(['storage', 'ledger_lock']).optional(),
});
export type BastionEvaluateRunSlice = z.infer<typeof bastionEvaluateRunSliceSchema>;

/** One run the evaluate-tick engine asks the worker to drive. */
export const bastionTickRunSchema = z.object({
  organization_id: z.string().uuid(),
  run_id: z.string().uuid(),
  resume_count: z.number().int().nonnegative(),
  /** > 0 for the orphan re-enqueue, so it is never deduplicated against an older job id. */
  generation: z.number().int().nonnegative(),
  why: z.enum(['nightly_created', 'nightly_resumed', 'orphan_requeue']),
});
export type BastionTickRun = z.infer<typeof bastionTickRunSchema>;

/** One queued LLM compile run the tick asks the worker to drive (M7; the orphan rule of spec 7). */
export const bastionTickCompileRunSchema = z.object({
  organization_id: z.string().uuid(),
  run_id: z.string().uuid(),
  resume_count: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
export type BastionTickCompileRun = z.infer<typeof bastionTickCompileRunSchema>;

/** One answering questionnaire nobody is driving (M8; the orphan rule of spec 7). */
export const bastionTickQuestionnaireRunSchema = z.object({
  organization_id: z.string().uuid(),
  questionnaire_id: z.string().uuid(),
  resume_count: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
export type BastionTickQuestionnaireRun = z.infer<typeof bastionTickQuestionnaireRunSchema>;

/** 200 `data` of POST /internal/engines/evaluate-tick. `compile_runs` joined at M7, `questionnaire_runs` at M8. */
export const bastionEvaluateTickResultSchema = z.object({
  runs: z.array(bastionTickRunSchema),
  compile_runs: z.array(bastionTickCompileRunSchema).default([]),
  questionnaire_runs: z.array(bastionTickQuestionnaireRunSchema).default([]),
});
export type BastionEvaluateTickResult = z.infer<typeof bastionEvaluateTickResultSchema>;

/**
 * 409 body of evaluate-run when another claimant holds the run. `heartbeat_stale: true` tells
 * the worker to wait 30 s and retry (that claim will be taken over at the lease, spec 7).
 */
export const bastionRunClaimedErrorSchema = z.object({
  error: z.object({
    code: z.literal('RUN_CLAIMED'),
    message: z.string(),
    details: z.array(z.unknown()),
    request_id: z.string(),
    claimed_by: z.string().nullable(),
    heartbeat_stale: z.boolean(),
  }),
});
export type BastionRunClaimedError = z.infer<typeof bastionRunClaimedErrorSchema>;

/* ------------------------------------------------------------------ */
/*  M5: manual evidence, personal data, feeds, coverage               */
/* ------------------------------------------------------------------ */

/**
 * Bin scan_status values and what Bastion does with each (spec 3.3). `clean` and `skipped` are
 * copied at attach (`skipped` is labelled "Not virus-scanned"); `pending` waits; `infected` and
 * `error` block the item.
 */
export const BASTION_BIN_SCAN_OUTCOME = {
  clean: { action: 'copy', scan_label: 'clean' },
  skipped: { action: 'copy', scan_label: 'not_scanned' },
  pending: { action: 'wait', scan_label: null },
  infected: { action: 'block', blocked_reason: 'infected' },
  error: { action: 'block', blocked_reason: 'scan_failed' },
} as const;
export type BastionBinScanStatus = keyof typeof BASTION_BIN_SCAN_OUTCOME;

/** A pending scan surfaces in the review queue after this long, then retries once a day. */
export const BASTION_PENDING_SCAN_CAP_HOURS = 24;
/** One day in milliseconds: the single day-length constant every Bastion consumer uses (#215). */
export const BASTION_DAY_MS = 86_400_000;
/** BASTION_PENDING_SCAN_CAP_HOURS in milliseconds: the "stuck scan" cutoff (locker, filter, banner). */
export const BASTION_PENDING_SCAN_CAP_MS = BASTION_PENDING_SCAN_CAP_HOURS * 3_600_000;

const manualCommon = {
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().max(4000).nullable().optional(),
  source_system: z.string().trim().min(1).max(128),
  owner_user_id: z.string().uuid(),
  produced_on: isoDate,
  period_start: isoDate.nullable().optional(),
  period_end: isoDate.nullable().optional(),
  /** The last day the evidence is good for; stored as the end of that day in the org's zone. */
  valid_until: isoDate,
  sensitivity: BastionEvidenceSensitivity.default('standard'),
  /** "I confirm this is a true copy of what {source_system} produced." Must be true. */
  uploader_statement: z.literal(true),
  /** Manual checks this item proves; each link waits for a second person's review. */
  assertion_ids: z.array(z.string().uuid()).max(20).optional(),
};

const periodOrder = (b: { period_start?: string | null; period_end?: string | null; produced_on: string; valid_until: string }) =>
  (!b.period_start || !b.period_end || b.period_start <= b.period_end) && b.produced_on <= b.valid_until;

/**
 * POST /manual-evidence and POST /manual-evidence/:id/supersede (spec 5.1 rows 32 and 40). A
 * file points at a Bin asset the person already uploaded; a statement carries its own text.
 */
export const bastionManualEvidenceCreateSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), bin_asset_id: z.string().uuid(), ...manualCommon }).strict(),
    z
      .object({ kind: z.literal('attestation_statement'), statement: z.string().trim().min(1).max(8000), ...manualCommon })
      .strict(),
  ])
  .refine(periodOrder, { message: 'Check the dates: the period must not end before it starts, and it cannot expire before it was produced', path: ['valid_until'] });
export type BastionManualEvidenceCreate = z.infer<typeof bastionManualEvidenceCreateSchema>;

/** GET /manual-evidence filters (row 33). `stuck` lists scans pending past the 24 h cap. */
export const bastionManualEvidenceListQuerySchema = z
  .object({
    status: BastionManualEvidenceStatus.optional(),
    kind: BastionManualEvidenceKind.optional(),
    assertion_id: z.string().uuid().optional(),
    control_id: z.string().uuid().optional(),
    stuck: boolQueryParam().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type BastionManualEvidenceListQuery = z.infer<typeof bastionManualEvidenceListQuerySchema>;

/** POST /manual-evidence/:id/links (row 36). */
export const bastionManualEvidenceLinkSchema = z.object({ assertion_id: z.string().uuid() }).strict();
export type BastionManualEvidenceLink = z.infer<typeof bastionManualEvidenceLinkSchema>;

/** POST /manual-evidence/:id/links/:assertion_id/review (row 38): a second person's verdict. */
export const bastionManualEvidenceReviewSchema = z
  .object({
    verdict: z.enum(['accepted', 'shows_exception']),
    note: z.string().trim().max(2000).nullable().optional(),
    /**
     * The verdict the reviewer saw (#216). A link that already has a verdict is only replaced when
     * this matches it; otherwise 409 REVIEW_CHANGED, so a stale Accept never erases a finding.
     */
    expected_verdict: z.enum(['pending', 'accepted', 'shows_exception']).optional(),
  })
  .strict();
export type BastionManualEvidenceReview = z.infer<typeof bastionManualEvidenceReviewSchema>;

/** POST /manual-evidence/:id/withdraw (row 39). Destructive: needs confirm. */
export const bastionManualEvidenceWithdrawSchema = z
  .object({ confirm: z.literal(true), reason: z.string().trim().max(2000).nullable().optional() })
  .strict();
export type BastionManualEvidenceWithdraw = z.infer<typeof bastionManualEvidenceWithdrawSchema>;

/** POST /personal-data/:id/redact (row 41). Owner only, confirm-gated, a reason is required. */
export const bastionRedactSchema = z
  .object({ confirm: z.literal(true), reason: z.string().trim().min(1).max(2000) })
  .strict();
export type BastionRedact = z.infer<typeof bastionRedactSchema>;

const feedKeySlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{1,62}$/, 'Use lower-case letters, digits, dashes or underscores');

/** POST /feeds (row 43). */
export const bastionFeedCreateSchema = z
  .object({
    feed_key: feedKeySlug,
    label: z.string().trim().min(1).max(256),
    feed_kind: z.string().trim().max(64).nullable().optional(),
    source_kind: BastionFeedSourceKind.default('api_push'),
    bolt_source: z.string().trim().min(1).max(32).nullable().optional(),
    bolt_event_type: z.string().trim().min(1).max(128).nullable().optional(),
    cadence_days: z.number().int().min(1).max(365).default(1),
    daily_record_quota: z.number().int().min(1).max(100_000).default(5000),
  })
  .strict()
  .refine((b) => b.source_kind !== 'bolt_event' || (!!b.bolt_source && !!b.bolt_event_type), {
    message: 'A Bolt-event feed needs the event source and type',
    path: ['bolt_event_type'],
  });
export type BastionFeedCreate = z.infer<typeof bastionFeedCreateSchema>;

/** PATCH /feeds/:id (row 44). */
export const bastionFeedUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(256).optional(),
    cadence_days: z.number().int().min(1).max(365).optional(),
    daily_record_quota: z.number().int().min(1).max(100_000).optional(),
    status: BastionFeedStatus.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionFeedUpdate = z.infer<typeof bastionFeedUpdateSchema>;

/** POST /feeds/:id/keys (row 46). The secret is shown once in the response. */
export const bastionFeedKeyCreateSchema = z
  .object({ label: z.string().trim().max(128).nullable().optional() })
  .strict();
export type BastionFeedKeyCreate = z.infer<typeof bastionFeedKeyCreateSchema>;

/** Rotation grace for the previous key when a new one is minted (spec 3.5). */
export const BASTION_FEED_KEY_GRACE_DAYS = 7;
/** Requests per minute per feed key (spec 3.5). */
export const BASTION_FEED_KEY_RATE_PER_MINUTE = 60;
/** Feed key token prefix: `bbf_<key_id>_<secret>`. */
export const BASTION_FEED_KEY_PREFIX = 'bbf_';

/** GET /feeds/:id/records (row 49). */
export const bastionFeedRecordListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type BastionFeedRecordListQuery = z.infer<typeof bastionFeedRecordListQuerySchema>;

/** GET /coverage and GET /summary (rows 50, 94): an optional framework view. */
export const bastionCoverageQuerySchema = z
  .object({ framework_id: z.string().uuid().optional() })
  .strict();
export type BastionCoverageQuery = z.infer<typeof bastionCoverageQuerySchema>;

/** The Evidence map columns (spec 6.1): where a control's proof comes from. */
export const BastionEvidenceSourceColumn = z.enum(['native', 'feed', 'manual_file', 'self_attested', 'none']);
export type BastionEvidenceSourceColumn = z.infer<typeof BastionEvidenceSourceColumn>;

/** Readiness banners (spec 6.1). */
export const BastionReadinessBanner = z.enum([
  'no_compliance_project',
  /** Set, but deleted or with no open phase: every task is refused until it is fixed (#229). */
  'compliance_project_unavailable',
  'checks_stale',
  'scanning_off',
  'storage_not_set_up',
  'offsite_backup_not_configured',
  'restore_pending',
  'delivery_problems',
  'stuck_scans',
]);
export type BastionReadinessBanner = z.infer<typeof BastionReadinessBanner>;

/** The four numbers plus "Not set up yet" and the denominator (spec 2.3). */
export const bastionReadinessNumbersSchema = z.object({
  proven_by_suite: z.number().int(),
  proven_by_evidence: z.number().int(),
  not_met: z.number().int(),
  risk_accepted: z.number().int(),
  cant_prove: z.number().int(),
  not_set_up: z.number().int(),
  checked: z.number().int(),
  total: z.number().int(),
});
export type BastionReadinessNumbersOut = z.infer<typeof bastionReadinessNumbersSchema>;

/* ------------------------------------------------------------------ */
/*  M6: gaps, fixes, exceptions, drift, the internal Bam routes       */
/* ------------------------------------------------------------------ */

/** The org-level gap row derived at read time from effectiveStatus, never stored (spec 2.3). */
export const BASTION_STALE_GAP_KIND = 'stale' as const;
/** A population confirmed longer ago than this asks for a re-confirmation (spec 2.3). */
export const BASTION_POPULATION_REVIEW_DAYS = 180;
/** population_review carries cost 2 although its template is confirm_check (spec 2.3). */
export const BASTION_POPULATION_REVIEW_COST = 2;
/** Mirrored fix proposals expire after this many days (spec 2.4). */
export const BASTION_FIX_PROPOSAL_TTL_DAYS = 14;
/** Orgs with fewer active humans than this may self-approve, labelled as such (spec 2.6). */
export const BASTION_SMALL_TEAM_HUMANS = 3;

/** GET /gaps (row 51). `active` is open plus proposed (a drafted fix not yet decided). */
export const bastionGapListQuerySchema = z
  .object({
    framework_id: z.string().uuid().optional(),
    control_id: z.string().uuid().optional(),
    status: z.enum(['active', 'open', 'proposed', 'dismissed', 'resolved', 'all']).default('active'),
    gap_kind: BastionGapKind.optional(),
    sort: z.enum(['risk', 'quick_wins']).default('risk'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type BastionGapListQuery = z.infer<typeof bastionGapListQuerySchema>;

/** POST /gaps/:id/propose-fix (row 52). The template comes from the gap; nobody picks it. */
export const bastionProposeFixSchema = z
  .object({ note: z.string().trim().max(2000).nullable().optional() })
  .strict();
export type BastionProposeFix = z.infer<typeof bastionProposeFixSchema>;

/** POST /gaps/:id/dismiss (row 53). */
export const bastionGapDismissSchema = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
export type BastionGapDismiss = z.infer<typeof bastionGapDismissSchema>;

/** GET /fix-drafts (row 54). */
export const bastionFixDraftListQuerySchema = z
  .object({
    status: BastionFixDraftStatus.optional(),
    gap_id: z.string().uuid().optional(),
    control_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type BastionFixDraftListQuery = z.infer<typeof bastionFixDraftListQuerySchema>;

/** POST /fix-drafts/:id/decide (row 56). Humans decide in Bastion, with a session (spec 2.8). */
export const bastionFixDecideSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type BastionFixDecide = z.infer<typeof bastionFixDecideSchema>;

/** What an approved fix can point at once it is done elsewhere (spec 2.4, 8.3). */
export const BastionFixAppliedEntityType = z.enum(['beacon.entry', 'bolt.rule']);
export type BastionFixAppliedEntityType = z.infer<typeof BastionFixAppliedEntityType>;

/**
 * A Beacon article slug, as the address bar shows it (/beacon/<slug>), for routes that accept a
 * pasted Beacon link (#232, #239). bastion-api resolves it to the article id in the org.
 */
export const bastionBeaconSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(256)
  .regex(BEACON_SLUG, "That doesn't look like a Beacon article link");

/**
 * POST /fix-drafts/:id/mark-applied (row 57). What was made is named by its id, or, for a Beacon
 * article, by the slug in its link (#232); never both.
 */
export const bastionFixMarkAppliedSchema = z
  .object({
    applied_entity_type: BastionFixAppliedEntityType.nullable().optional(),
    applied_entity_id: z.string().uuid().nullable().optional(),
    applied_entity_slug: bastionBeaconSlugSchema.nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const named = !!b.applied_entity_id || !!b.applied_entity_slug;
    if (!!b.applied_entity_type !== named) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give both the kind of thing you made and its link, or neither', path: ['applied_entity_id'] });
    }
    if (b.applied_entity_id && b.applied_entity_slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Give the id or the link, not both', path: ['applied_entity_slug'] });
    }
    if (b.applied_entity_slug && b.applied_entity_type !== 'beacon.entry') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a Beacon article can be named by its link', path: ['applied_entity_slug'] });
    }
  });
export type BastionFixMarkApplied = z.infer<typeof bastionFixMarkAppliedSchema>;

/** GET /exceptions (row 58). */
export const bastionExceptionListQuerySchema = z
  .object({
    status: BastionExceptionStatus.optional(),
    control_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type BastionExceptionListQuery = z.infer<typeof bastionExceptionListQuerySchema>;

/**
 * POST /exceptions (row 60). An entity exception names one cited ref and lasts up to 365 days;
 * an assertion-wide one covers only the refs failing when it is approved and lasts up to 90
 * (spec 2.6). `expires_on` is a local date in the org's zone (end of that day).
 */
export const bastionExceptionProposeSchema = z
  .object({
    control_id: z.string().uuid(),
    scope: BastionExceptionScope,
    assertion_id: z.string().uuid().nullable().optional(),
    // An app entity (`bam.task`) or a probe's platform ref (`api_key`, `user`, `github_pr_event`).
    cited_entity_type: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]+)?$/, 'Use an entity type like api_key or bam.task')
      .max(48)
      .nullable()
      .optional(),
    cited_entity_id: z.string().uuid().nullable().optional(),
    reason: z.string().trim().min(1).max(2000),
    compensating_note: z.string().trim().max(2000).nullable().optional(),
    expires_on: isoDate,
  })
  .strict()
  .refine((b) => b.scope !== 'entity' || (!!b.cited_entity_type && !!b.cited_entity_id), {
    message: 'An exception for one item needs the item it covers',
    path: ['cited_entity_id'],
  })
  .refine((b) => b.scope !== 'assertion' || !!b.assertion_id, {
    message: 'An exception for a whole check needs the check it covers',
    path: ['assertion_id'],
  });
export type BastionExceptionPropose = z.infer<typeof bastionExceptionProposeSchema>;

/** POST /exceptions/:id/decide (row 61, confirm). Humans decide in Bastion (spec 2.6, 2.8). */
export const bastionExceptionDecideSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    confirm: z.literal(true),
    reason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type BastionExceptionDecide = z.infer<typeof bastionExceptionDecideSchema>;

/** GET /drift (row 62). */
export const bastionDriftListQuerySchema = z
  .object({
    control_id: z.string().uuid().optional(),
    unacknowledged: boolQueryParam().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type BastionDriftListQuery = z.infer<typeof bastionDriftListQuerySchema>;

/** POST /drift/:id/acknowledge (row 63). */
export const bastionDriftAcknowledgeSchema = z
  .object({ note: z.string().trim().max(2000).nullable().optional() })
  .strict();
export type BastionDriftAcknowledge = z.infer<typeof bastionDriftAcknowledgeSchema>;

/**
 * Bolt rule shapes (spec 2.4): the only actions a drafted rule may carry. send_webhook and every
 * send_email* action are refused, so a drafted rule can never send anything outside the suite.
 */
export const BASTION_BOLT_RULE_ALLOWED_ACTIONS = ['create_task', 'banter_post_message'] as const;
export type BastionBoltRuleAction = (typeof BASTION_BOLT_RULE_ALLOWED_ACTIONS)[number];

/** The one Bam task per control (spec 2.5): `bastion:control:<control_id>`. */
export function bastionControlTaskExternalId(controlId: string): string {
  return `bastion:control:${controlId}`;
}

const controlTaskExternalId = z
  .string()
  .regex(/^bastion:control:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'external_id must be bastion:control:<control id>');

/**
 * POST /internal/bastion/tasks/upsert (api-owned, spec 8.4). Creates the control's task in the
 * project's start phase, or, when it sits in a terminal phase, moves it back to the start phase
 * and posts `comment`; on an open task `comment` is posted as an update. The comment is
 * deduplicated on idempotency_key, so a retried delivery never posts it twice.
 */
export const bastionBamTaskUpsertSchema = z
  .object({
    org_id: z.string().uuid(),
    project_id: z.string().uuid(),
    control_id: z.string().uuid(),
    external_id: controlTaskExternalId,
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).nullable().optional(),
    assignee_id: z.string().uuid().nullable().optional(),
    comment: z.string().trim().min(1).max(4000).nullable().optional(),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();
export type BastionBamTaskUpsert = z.infer<typeof bastionBamTaskUpsertSchema>;

export const bastionBamTaskUpsertResultSchema = z.object({
  task_id: z.string().uuid(),
  human_id: z.string(),
  outcome: z.enum(['created', 'reopened', 'updated']),
  comment_posted: z.boolean(),
});
export type BastionBamTaskUpsertResult = z.infer<typeof bastionBamTaskUpsertResultSchema>;

/** POST /internal/bastion/tasks/comment: a comment addressed by external_id, never by task id. */
export const bastionBamTaskCommentSchema = z
  .object({
    org_id: z.string().uuid(),
    project_id: z.string().uuid(),
    external_id: controlTaskExternalId,
    body: z.string().trim().min(1).max(4000),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();
export type BastionBamTaskComment = z.infer<typeof bastionBamTaskCommentSchema>;

export const bastionBamTaskCommentResultSchema = z.object({
  task_id: z.string().uuid().nullable(),
  comment_id: z.string().uuid().nullable(),
  outcome: z.enum(['posted', 'duplicate', 'no_task']),
});
export type BastionBamTaskCommentResult = z.infer<typeof bastionBamTaskCommentResultSchema>;

/**
 * POST /internal/bastion/proposals/:id/close (api-owned, spec 2.8, 8.4). Accepted only for a
 * proposal with owning_app = 'bastion' whose decider is a human member of its org who decided
 * with a session; records the decider in the #128 columns and emits proposal.decided.
 */
export const bastionProposalCloseSchema = z
  .object({
    org_id: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    decided_by: z.string().uuid(),
    decided_auth_method: z.literal('session'),
    reason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type BastionProposalClose = z.infer<typeof bastionProposalCloseSchema>;

export const bastionProposalCloseResultSchema = z.object({
  proposal_id: z.string().uuid(),
  status: z.string(),
  already_closed: z.boolean(),
});
export type BastionProposalCloseResult = z.infer<typeof bastionProposalCloseResultSchema>;

/* ------------------------------------------------------------------ */
/*  M7: the LLM-tailored compile on the worker; policies, attestation */
/* ------------------------------------------------------------------ */

/** M7 (spec 7): the LLM-tailored compile (event) and the daily attestation nudge. */
export const BASTION_COMPILE_QUEUE = 'bastion-compile';
export const BASTION_ATTESTATION_NUDGE_QUEUE = 'bastion-attestation-nudge';

/** One LLM compile run to drive (spec 7.3). Same handover rule as evaluate-run (issue #201). */
export interface BastionCompileJobData {
  organization_id: string;
  run_id: string;
  resume_count: number;
  claimant?: string;
}

/** The jobId for a bastion-compile job (BullMQ forbids ':'; see bastionEvaluateRunJobId). */
export function bastionCompileJobId(runId: string, resumeCount: number, generation = 0): string {
  return generation > 0 ? `compile-${runId}-r${resumeCount}-g${generation}` : `compile-${runId}-r${resumeCount}`;
}

/** Body of the compile engine: start (or report on) one async LLM slice of one run. */
export const bastionCompileEngineSchema = z
  .object({
    organization_id: z.string().uuid(),
    run_id: z.string().uuid(),
    claimant: z.string().min(1).max(128),
  })
  .strict();
export type BastionCompileEngine = z.infer<typeof bastionCompileEngineSchema>;

/**
 * 200 `data` of POST /internal/engines/compile. Slices are async-start (spec 7.3): the call
 * starts a slice in bastion-api (or reports on the one running) and answers at once; the worker
 * polls every 15 s. `released` means bastion-api is shutting down and gave the run back (queued,
 * resume_count + 1); the tick re-enqueues it.
 */
export const bastionCompileSliceSchema = z.object({
  done: z.boolean(),
  status: BastionRunStatus,
  controls_done: z.number().int().nonnegative(),
  controls_total: z.number().int().nonnegative(),
  assertions_proposed: z.number().int().nonnegative(),
  assertions_dropped: z.number().int().nonnegative(),
  llm_calls_used: z.number().int().nonnegative(),
  /** Controls given the library's suggestions instead of the AI's (no answer, error, budget). */
  fallback_controls: z.number().int().nonnegative(),
  /** Of fallback_controls: answers that stopped at max_tokens (finish_reason 'length', #237). */
  cut_off_controls: z.number().int().nonnegative().optional(),
  /** Of fallback_controls: AI calls that ran past their deadline (BASTION_LLM_TIMEOUT_MS, #257). */
  timed_out_controls: z.number().int().nonnegative().optional(),
  slice_running: z.boolean(),
  released: z.boolean().optional(),
  waiting: z.enum(['ai_slot', 'ai_throttled']).nullable().optional(),
});
export type BastionCompileSlice = z.infer<typeof bastionCompileSliceSchema>;

/**
 * GET /frameworks/:id/not-applicable-suggestions (#238): the AI compile's "this requirement may
 * not apply" suggestions (spec 2.1 step 2), for a person to decide in Setup. Only requirements
 * nobody has decided yet are served; deciding one (either way) removes it.
 */
export const bastionNotApplicableSuggestionSchema = z.object({
  ref_code: z.string(),
  title: z.string(),
  /** The first control's reason, offered as the starting text of the person's own reason. */
  suggested_reason: z.string(),
  controls: z.array(z.object({ control_key: z.string(), control_title: z.string().nullable(), reason: z.string() })),
});
export type BastionNotApplicableSuggestion = z.infer<typeof bastionNotApplicableSuggestionSchema>;

export const bastionNotApplicableSuggestionsSchema = z.object({
  data: z.array(bastionNotApplicableSuggestionSchema),
  /** The compile run the suggestions came from (the newest one that made any), or null. */
  compile_run_id: z.string().uuid().nullable(),
});
export type BastionNotApplicableSuggestions = z.infer<typeof bastionNotApplicableSuggestionsSchema>;

/**
 * POST /policies (row 65): link a Beacon article as a policy people read and acknowledge. The article is named by its id, or by the slug in the link Beacon
 * shows (/beacon/<slug>), which bastion-api resolves in the org (#239); exactly one of the two.
 */
export const bastionPolicyCreateFields = z
  .object({
    beacon_entry_id: z.string().uuid().optional(),
    beacon_slug: bastionBeaconSlugSchema.optional(),
    audience: bastionPolicyAudienceSchema.default({ kind: 'all' }),
    cadence_days: z.number().int().min(1).max(1095).default(365),
    owner_user_id: z.string().uuid().nullable().optional(),
    /**
     * Optional: the control this policy proves. Bastion proposes the two policy checks (read and
     * acknowledged; kept current) on it, pinned to this policy, for a person to confirm. Left
     * out, the one control whose policy checks are not pinned to an active policy is used (#387).
     */
    control_id: z.string().uuid().optional(),
  })
  .strict();
export const bastionPolicyCreateSchema = bastionPolicyCreateFields.refine((b) => !!b.beacon_entry_id !== !!b.beacon_slug, {
  message: 'Paste the link to the Beacon article',
  path: ['beacon_entry_id'],
});
export type BastionPolicyCreate = z.infer<typeof bastionPolicyCreateSchema>;

/** PATCH /policies/:id (row 66). Retiring keeps every attestation (they are immutable). */
export const bastionPolicyUpdateSchema = z
  .object({
    audience: bastionPolicyAudienceSchema.optional(),
    cadence_days: z.number().int().min(1).max(1095).optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    status: BastionPolicyStatus.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionPolicyUpdate = z.infer<typeof bastionPolicyUpdateSchema>;

/** GET /policies (row 64). */
export const bastionPolicyListQuerySchema = z
  .object({
    status: z.enum(['active', 'retired', 'all']).default('active'),
  })
  .strict();
export type BastionPolicyListQuery = z.infer<typeof bastionPolicyListQuerySchema>;

/**
 * POST /policies/:id/attest (row 70). The reader sends back the version and hash Bastion served
 * (GET /policies/:id/body); a mismatch means the policy changed while they read it (409).
 */
export const bastionAttestSchema = z
  .object({
    beacon_version: z.number().int().min(1),
    body_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'A SHA-256 in lowercase hex'),
  })
  .strict();
export type BastionAttest = z.infer<typeof bastionAttestSchema>;

/** POST /policies/:id/request-attestations (row 71): nudge everyone (or the named people) still due. */
export const bastionRequestAttestationsSchema = z
  .object({
    user_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
  })
  .strict();
export type BastionRequestAttestations = z.infer<typeof bastionRequestAttestationsSchema>;

/* ------------------------------------------------------------------ */
/*  M8: questionnaires, the answer library, autofill on the worker     */
/* ------------------------------------------------------------------ */

/** M8 (spec 7): async-start LLM slices that draft a questionnaire's answers. */
export const BASTION_QUESTIONNAIRE_AUTOFILL_QUEUE = 'bastion-questionnaire-autofill';

/** A Bin questionnaire file larger than this is refused (questionnaires are small). */
export const BASTION_QUESTIONNAIRE_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
/** Pasted rows (copied from a spreadsheet: tabs, or CSV). */
export const BASTION_QUESTIONNAIRE_MAX_PASTED_CHARS = 500_000;
/** Columns kept per row when a questionnaire is read (a wider sheet is cut, and says so). */
export const BASTION_QUESTIONNAIRE_MAX_COLUMNS = 40;
/** Cell text kept per cell (the question column is 4000, the database limit). */
export const BASTION_QUESTIONNAIRE_MAX_CELL_CHARS = 4000;
/**
 * Cells kept across every sheet of one questionnaire, empty cells before a filled one included
 * (#265, #273). A file holding more is refused, not stored.
 */
export const BASTION_QUESTIONNAIRE_MAX_CELLS = 200_000;
/**
 * Characters kept across every cell of one questionnaire, a repeated (shared) cell counted every
 * time it appears (#265, #273). This, not the file size, bounds what is read and stored.
 */
export const BASTION_QUESTIONNAIRE_MAX_TOTAL_CHARS = 4_000_000;

/** Plain words for the three confidence bands (spec 6.1). */
export const BASTION_CONFIDENCE_WORDS: Record<BastionConfidenceBand, string> = {
  high: 'Sure',
  medium: 'Check this',
  low: 'Needs an expert',
};

/** One readable sheet's mapping: which column holds what, and where the questions start. */
export const bastionQuestionnaireSheetMapSchema = z
  .object({
    sheet_name: z.string().max(128),
    /** 0-based row of the header (null when the sheet has none). */
    header_row: z.number().int().min(0).nullable(),
    /** 0-based first row holding a question. */
    first_row: z.number().int().min(0),
    question_column: z.number().int().min(0).max(BASTION_QUESTIONNAIRE_MAX_COLUMNS - 1),
    answer_column: z.number().int().min(0).max(BASTION_QUESTIONNAIRE_MAX_COLUMNS - 1).nullable(),
    yes_no_column: z.number().int().min(0).max(BASTION_QUESTIONNAIRE_MAX_COLUMNS - 1).nullable(),
    section_column: z.number().int().min(0).max(BASTION_QUESTIONNAIRE_MAX_COLUMNS - 1).nullable(),
    answer_kind: BastionAnswerKind.default('yes_no_text'),
  })
  .strict()
  .refine((m) => m.header_row === null || m.first_row > m.header_row, { message: 'Questions must start below the header row', path: ['first_row'] })
  .refine((m) => ![m.answer_column, m.yes_no_column, m.section_column].includes(m.question_column), {
    message: 'The question column cannot also be the answer, yes/no or section column',
    path: ['question_column'],
  });
export type BastionQuestionnaireSheetMap = z.infer<typeof bastionQuestionnaireSheetMapSchema>;

/** The whole mapping: one entry per sheet that holds questions. */
export const bastionQuestionnaireColumnMapSchema = z
  .object({
    sheets: z.array(bastionQuestionnaireSheetMapSchema).min(1).max(20),
  })
  .strict();
export type BastionQuestionnaireColumnMap = z.infer<typeof bastionQuestionnaireColumnMapSchema>;

const questionnaireSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bin_asset'), bin_asset_id: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('pasted'),
      text: z.string().min(1).max(BASTION_QUESTIONNAIRE_MAX_PASTED_CHARS),
      /** Rows copied from a spreadsheet arrive tab-separated; a CSV file's text is comma-separated. */
      format: z.enum(['csv', 'tsv']).default('tsv'),
    })
    .strict(),
]);

/** POST /questionnaires (row 73): from a Bin file (xlsx or csv) or pasted rows. */
export const bastionQuestionnaireCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(512),
    requester_label: z.string().trim().max(256).nullable().optional(),
    source: questionnaireSource,
    bond_deal_id: z.string().uuid().nullable().optional(),
    due_date: isoDate.nullable().optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    /** Optional: the mapping, when the caller already knows it (else Bastion guesses one to check). */
    column_map: bastionQuestionnaireColumnMapSchema.optional(),
  })
  .strict();
export type BastionQuestionnaireCreate = z.infer<typeof bastionQuestionnaireCreateSchema>;

/** PATCH /questionnaires/:id (row 75): details, and the column mapping while it is being set up. */
export const bastionQuestionnaireUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(512).optional(),
    requester_label: z.string().trim().max(256).nullable().optional(),
    due_date: isoDate.nullable().optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    bond_deal_id: z.string().uuid().nullable().optional(),
    column_map: bastionQuestionnaireColumnMapSchema.optional(),
    /**
     * #266: a column_map that leaves out a sheet which holds questions now is refused (409
     * SHEETS_DROPPED) unless this is true, so a mapping fixed on one sheet never silently drops
     * the questions on the others.
     */
    drop_unmapped_sheets: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionQuestionnaireUpdate = z.infer<typeof bastionQuestionnaireUpdateSchema>;

/** GET /questionnaires (row 72). */
export const bastionQuestionnaireListQuerySchema = z
  .object({
    status: BastionQuestionnaireStatus.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BastionQuestionnaireListQuery = z.infer<typeof bastionQuestionnaireListQuerySchema>;

/** GET /questionnaires/:id/items (row 77). Flags are explicit strings, never z.coerce.boolean. */
export const bastionQuestionnaireItemListQuerySchema = z
  .object({
    band: BastionConfidenceBand.optional(),
    review_status: BastionItemReviewStatus.optional(),
    needs_review: boolQueryParam().optional(),
  })
  .strict();
export type BastionQuestionnaireItemListQuery = z.infer<typeof bastionQuestionnaireItemListQuerySchema>;

/**
 * POST /questionnaires/:id/autofill (row 76, 202). `redraft` drafts again every row nobody reviewed
 * yet. `use_ai: false` drafts without calling the AI (#271): each row reuses a strong approved
 * answer from the library, with the hard rules applied to the controls it cites, or is left for a
 * person. Deterministic, so the seed and its story tests do not depend on a live model.
 */
export const bastionQuestionnaireAutofillSchema = z
  .object({
    redraft: z.boolean().default(false),
    use_ai: z.boolean().default(true),
  })
  .strict();
export type BastionQuestionnaireAutofill = z.infer<typeof bastionQuestionnaireAutofillSchema>;

/** PATCH /questionnaire-items/:id (row 78): a person's review of one drafted answer. */
export const bastionQuestionnaireItemReviewSchema = z
  .object({
    review_status: z.enum(['accepted', 'edited', 'needs_owner', 'pending']),
    final_answer: z.string().max(8000).nullable().optional(),
    final_yes_no: z.boolean().nullable().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((b) => b.review_status !== 'edited' || (b.final_answer !== undefined && b.final_answer !== null) || b.final_yes_no !== undefined, {
    message: 'An edited answer needs the new text or yes/no',
    path: ['final_answer'],
  })
  .refine((b) => b.review_status !== 'needs_owner' || !!b.assigned_to, {
    message: 'Say who should answer it',
    path: ['assigned_to'],
  });
export type BastionQuestionnaireItemReview = z.infer<typeof bastionQuestionnaireItemReviewSchema>;

/** POST /questionnaires/:id/approve (row 79): a vouching act; the body confirms it. */
export const bastionQuestionnaireApproveSchema = z.object({ confirm: z.literal(true) }).strict();
export type BastionQuestionnaireApprove = z.infer<typeof bastionQuestionnaireApproveSchema>;

/** GET /questionnaires/:id/export (row 80). */
export const bastionQuestionnaireExportQuerySchema = z
  .object({
    format: z.enum(['xlsx', 'csv']).optional(),
  })
  .strict();
export type BastionQuestionnaireExportQuery = z.infer<typeof bastionQuestionnaireExportQuerySchema>;

/** POST /answers/draft (row 81): draft one answer now, nothing saved. */
export const bastionDraftAnswerSchema = z
  .object({
    question: z.string().trim().min(3).max(BASTION_QUESTIONNAIRE_MAX_CELL_CHARS),
    answer_kind: BastionAnswerKind.default('yes_no_text'),
  })
  .strict();
export type BastionDraftAnswer = z.infer<typeof bastionDraftAnswerSchema>;

/** GET /answer-library (row 82). */
export const bastionAnswerLibraryQuerySchema = z
  .object({
    q: z.string().trim().max(500).optional(),
    include_stale: boolQueryParam().optional(),
    include_retired: boolQueryParam().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type BastionAnswerLibraryQuery = z.infer<typeof bastionAnswerLibraryQuerySchema>;

/** PATCH /answer-library/:id (row 83): reword, mark checked (clears stale) or retire. */
export const bastionAnswerLibraryUpdateSchema = z
  .object({
    answer_text: z.string().trim().min(1).max(8000).optional(),
    yes_no: z.boolean().nullable().optional(),
    /** false: a person checked the answer still holds after its control changed. */
    stale: z.literal(false).optional(),
    retired: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });
export type BastionAnswerLibraryUpdate = z.infer<typeof bastionAnswerLibraryUpdateSchema>;

/** One autofill run to drive (spec 7.3). Same handover rule as compile (issue #201). */
export interface BastionQuestionnaireJobData {
  organization_id: string;
  questionnaire_id: string;
  resume_count: number;
  claimant?: string;
}

/** The jobId for a bastion-questionnaire-autofill job (BullMQ forbids ':'). */
export function bastionQuestionnaireJobId(questionnaireId: string, resumeCount: number, generation = 0): string {
  return generation > 0 ? `qa-${questionnaireId}-r${resumeCount}-g${generation}` : `qa-${questionnaireId}-r${resumeCount}`;
}

/** Body of the questionnaire-autofill engine: start (or report on) one async LLM slice. */
export const bastionQuestionnaireEngineSchema = z
  .object({
    organization_id: z.string().uuid(),
    questionnaire_id: z.string().uuid(),
    claimant: z.string().min(1).max(128),
  })
  .strict();
export type BastionQuestionnaireEngine = z.infer<typeof bastionQuestionnaireEngineSchema>;

/** 200 `data` of POST /internal/engines/questionnaire-autofill (async-start, like compile). */
export const bastionQuestionnaireSliceSchema = z.object({
  done: z.boolean(),
  status: BastionQuestionnaireStatus,
  rows_done: z.number().int().nonnegative(),
  row_count: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
  slice_running: z.boolean(),
  released: z.boolean().optional(),
  waiting: z.enum(['ai_slot', 'ai_throttled']).nullable().optional(),
  /** AI calls charged to this questionnaire so far, across every run (#261). */
  llm_calls_used: z.number().int().nonnegative().optional(),
  /** Consecutive failed AI calls; the rows wait and are retried until it reaches the limit (#260). */
  ai_failure_streak: z.number().int().nonnegative().optional(),
});
export type BastionQuestionnaireSlice = z.infer<typeof bastionQuestionnaireSliceSchema>;

/* ------------------------------------------------------------------ */
/*  M9: auditor rooms, audit packets, settings, sweep and mirror      */
/* ------------------------------------------------------------------ */

/**
 * The auditor-room token travels in the URL FRAGMENT (`/bastion/room#<token>`), which browsers
 * never send to a server, and reaches bastion-api only as this header (spec 5.2), so it never
 * lands in an access log or a Referer.
 */
export const BASTION_ROOM_TOKEN_HEADER = 'x-bastion-room-token';
/** The optional 6-digit room passcode, sent as a header on every room request. */
export const BASTION_ROOM_PASSCODE_HEADER = 'x-bastion-room-passcode';
/** Default lifetime of a new room (spec 5.2: mandatory expiry, default 30 days). */
export const BASTION_ROOM_DEFAULT_DAYS = 30;
/** Wrong passcodes before a room locks itself and its creator is told (spec 5.2). */
export const BASTION_ROOM_PASSCODE_MAX_FAILURES = 5;
/** Auditor questions a room may send per hour (spec 5.2). */
export const BASTION_ROOM_REQUESTS_PER_HOUR = 20;
/** Unknown-token misses per client address before a 15-minute lockout (spec 5.2). */
export const BASTION_ROOM_TOKEN_MISSES = 10;
export const BASTION_ROOM_TOKEN_MISS_WINDOW_S = 600;
export const BASTION_ROOM_LOCKOUT_S = 900;
/** Room requests per minute per resolved client address (spec 5.2). */
export const BASTION_ROOM_RATE_PER_MINUTE = 120;
/** The longest period one audit packet may cover (spec 7.2). */
export const BASTION_PACKET_MAX_PERIOD_DAYS = 400;

function periodDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

const auditPeriodFields = {
  period_start: isoDate,
  period_end: isoDate,
};

/** POST /auditor-rooms (row 85): session-only, never impersonated, confirm-gated. */
export const bastionAuditorRoomCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(256),
    framework_id: z.string().uuid(),
    ...auditPeriodFields,
    /** Days the link works; at most the org's auditor_room_max_days and never above 180. */
    expires_in_days: z.number().int().min(1).max(BASTION_AUDITOR_ROOM_MAX_DAYS).default(BASTION_ROOM_DEFAULT_DAYS),
    passcode: z.string().regex(/^\d{6}$/, 'A passcode is 6 digits').optional(),
    /** Default: every control the framework applies to. */
    control_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
    /** The frozen allowlist of restricted evidence the auditor may see (spec 5.2). */
    restricted_evidence_ids: z.array(z.string().uuid()).max(500).default([]),
    confirm: z.literal(true),
  })
  .strict()
  .refine((b) => b.period_start <= b.period_end, { message: 'The period must end on or after it starts', path: ['period_end'] });
export type BastionAuditorRoomCreate = z.infer<typeof bastionAuditorRoomCreateSchema>;

/** POST /auditor-rooms/:id/revoke (row 86). */
export const bastionAuditorRoomRevokeSchema = z.object({ confirm: z.literal(true) }).strict();
export type BastionAuditorRoomRevoke = z.infer<typeof bastionAuditorRoomRevokeSchema>;

/** POST /auditor-rooms/:id/unlock (row 87): clears a passcode lockout. */
export const bastionAuditorRoomUnlockSchema = z.object({}).strict();
export type BastionAuditorRoomUnlock = z.infer<typeof bastionAuditorRoomUnlockSchema>;

/** GET /auditor-rooms (row 84). */
export const bastionAuditorRoomListQuerySchema = z
  .object({
    include_closed: boolQueryParam().optional(),
  })
  .strict();
export type BastionAuditorRoomListQuery = z.infer<typeof bastionAuditorRoomListQuerySchema>;

/** GET /auditor-rooms/:id/access-log (row 88), newest first. */
export const bastionAccessLogQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type BastionAccessLogQuery = z.infer<typeof bastionAccessLogQuerySchema>;

/** GET /auditor-requests (row 89). */
export const bastionAuditorRequestListQuerySchema = z
  .object({
    room_id: z.string().uuid().optional(),
    status: BastionAuditorRequestStatus.optional(),
  })
  .strict();
export type BastionAuditorRequestListQuery = z.infer<typeof bastionAuditorRequestListQuerySchema>;

/** PATCH /auditor-requests/:id (row 90): answer or close an auditor's question. */
export const bastionAuditorRequestUpdateSchema = z
  .object({
    status: z.enum(['answered', 'closed']),
    answer_note: z.string().trim().min(1).max(5000).optional(),
  })
  .strict()
  .refine((b) => b.status !== 'answered' || !!b.answer_note, { message: 'Write the answer', path: ['answer_note'] });
export type BastionAuditorRequestUpdate = z.infer<typeof bastionAuditorRequestUpdateSchema>;

/** POST /public/room/requests (row 104): an auditor's question from inside the room. */
export const bastionPublicRoomRequestSchema = z
  .object({
    control_id: z.string().uuid().optional(),
    requester_name: z.string().trim().min(1).max(256),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();
export type BastionPublicRoomRequest = z.infer<typeof bastionPublicRoomRequestSchema>;

/** The state words a room and a packet show for a control (spec 2.3, 6.2). */
export const BastionRoomControlState = z.enum(['met', 'not_met', 'risk_accepted', 'cant_prove', 'not_assessed']);
export type BastionRoomControlState = z.infer<typeof BastionRoomControlState>;
export const BASTION_ROOM_STATE_WORDS: Record<BastionRoomControlState, string> = {
  met: 'Met',
  not_met: 'Not met',
  risk_accepted: 'Not met, risk accepted',
  cant_prove: "Can't prove yet",
  not_assessed: 'Not assessed',
};

/** POST /exports (row 91): one audit packet, built by the worker. */
export const bastionExportCreateSchema = z
  .object({
    framework_id: z.string().uuid(),
    ...auditPeriodFields,
    include_restricted: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.period_start <= b.period_end, { message: 'The period must end on or after it starts', path: ['period_end'] })
  .refine((b) => periodDays(b.period_start, b.period_end) <= BASTION_PACKET_MAX_PERIOD_DAYS, {
    message: `A packet covers at most ${BASTION_PACKET_MAX_PERIOD_DAYS} days`,
    path: ['period_start'],
  });
export type BastionExportCreate = z.infer<typeof bastionExportCreateSchema>;

/** GET /exports (row 92). */
export const bastionExportListQuerySchema = z
  .object({
    status: BastionExportStatus.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type BastionExportListQuery = z.infer<typeof bastionExportListQuerySchema>;

/** The stages the packet job reports (spec 7.1), in order. */
export const BastionPacketStage = z.enum(['collecting', 'checking_commitments', 'writing_evidence', 'rendering_summary', 'zipping', 'uploading']);
export type BastionPacketStage = z.infer<typeof BastionPacketStage>;

/** PATCH /settings (row 97). Every field optional; the medium floor stays below the high floor. */
export const bastionSettingsUpdateFields = z
  .object({
    remediation_tasks: BastionRemediationTasks.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    evaluation_hour_local: z.number().int().min(0).max(23).optional(),
    llm_provider_id: z.string().uuid().nullable().optional(),
    stale_after_hours: z.number().int().min(12).max(168).optional(),
    not_assessed_grace_days: z.number().int().min(0).max(90).optional(),
    manual_expiry_warn_days: z.number().int().min(1).max(365).optional(),
    questionnaire_high_floor: z.number().min(0.5).max(0.99).optional(),
    questionnaire_medium_floor: z.number().min(0.1).max(0.95).optional(),
    max_llm_calls_per_compile: z.number().int().min(0).max(5000).optional(),
    max_llm_calls_per_questionnaire: z.number().int().min(0).max(10000).optional(),
    max_rows_per_questionnaire: z.number().int().min(10).max(5000).optional(),
    auditor_room_max_days: z.number().int().min(1).max(BASTION_AUDITOR_ROOM_MAX_DAYS).optional(),
    /** 10 MB to 10 GB. */
    max_packet_bytes: z.number().int().min(10 * 1024 * 1024).max(10 * 1024 * 1024 * 1024).optional(),
  })
  .strict();
/** The fields plus the cross-field rules (the route and the MCP tool both validate with this). */
export const bastionSettingsUpdateSchema = bastionSettingsUpdateFields
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' })
  .refine(
    (b) => b.questionnaire_high_floor === undefined || b.questionnaire_medium_floor === undefined || b.questionnaire_medium_floor < b.questionnaire_high_floor,
    { message: 'The "Check this" floor must be below the "Sure" floor', path: ['questionnaire_medium_floor'] },
  );
export type BastionSettingsUpdate = z.infer<typeof bastionSettingsUpdateSchema>;

/** GET /delivery-problems (row 98): dead outbox rows. */
export const bastionDeliveryProblemListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BastionDeliveryProblemListQuery = z.infer<typeof bastionDeliveryProblemListQuerySchema>;

/** POST /delivery-problems/:id/retry (row 99). */
export const bastionDeliveryRetrySchema = z.object({}).strict();
export type BastionDeliveryRetry = z.infer<typeof bastionDeliveryRetrySchema>;

/** GET /audit (row 100), newest first. */
export const bastionAuditLogQuerySchema = z
  .object({
    action: z.string().trim().min(1).max(64).optional(),
    subject_type: z.string().trim().min(1).max(48).optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BastionAuditLogQuery = z.infer<typeof bastionAuditLogQuerySchema>;

/** Worker queues (spec 7). object-sweep is scheduled; the other two are event-driven. */
export const BASTION_OBJECT_SWEEP_QUEUE = 'bastion-object-sweep';
export const BASTION_OBJECT_BACKUP_QUEUE = 'bastion-object-backup';
export const BASTION_EXPORT_PACKET_QUEUE = 'bastion-export-packet';

/** bastion-object-backup: enqueued by backup-database.job.ts after the backup is `completed`, jobId = backup id. */
export interface BastionObjectBackupJobData {
  backup_id: string;
}

/** bastion-export-packet: produced by POST /exports, jobId = packet id. */
export interface BastionExportPacketJobData {
  organization_id: string;
  packet_id: string;
  /** How many times this job has waited out another attempt's live claim (#326). */
  held_deferrals?: number;
}

/** The jobId of a packet build (BullMQ forbids ':'). */
export function bastionExportPacketJobId(packetId: string): string {
  return `packet-${packetId}`;
}

/** Body of the mirror-objects engine: one budgeted pass after one database backup. */
export const bastionMirrorEngineSchema = z
  .object({
    /** The platform_backups row the pass follows; absent for an operator's manual pass. */
    backup_id: z.string().uuid().optional(),
  })
  .strict();
export type BastionMirrorEngine = z.infer<typeof bastionMirrorEngineSchema>;

/** platform_backups.bastion_mirror_status values (spec 9.7). */
export const BastionMirrorStatus = z.enum(['not_configured', 'running', 'completed', 'partial', 'failed']);
export type BastionMirrorStatus = z.infer<typeof BastionMirrorStatus>;

/**
 * Object transfer bounds, shared by bastion-api (the off-site mirror copy) and the worker (the
 * packet upload, the mirror call timeout), so every deadline is derived from one fact (#332).
 *
 * The slowest sustained transfer rate Bastion waits for: 512 KB/s.
 */
export const BASTION_MIN_TRANSFER_BYTES_PER_S = 512 * 1024;
/** The largest evidence object Bastion stores (a manual upload; machine evidence is far smaller). */
export const BASTION_MAX_EVIDENCE_OBJECT_BYTES = 100 * 1024 * 1024;
/** Deadline for moving `bytes` at the floor rate, never under `floorMs`. */
export function bastionTransferTimeoutMs(bytes: number, floorMs: number): number {
  return Math.max(floorMs, Math.ceil(Math.max(0, bytes) / BASTION_MIN_TRANSFER_BYTES_PER_S) * 1000);
}
/** Minimum deadline for one mirror copy (small objects). */
export const BASTION_MIRROR_COPY_FLOOR_MS = 60_000;
/** Deadline for copying the largest evidence object to the mirror (200 s at the floor rate). */
export const BASTION_MIRROR_MAX_COPY_MS = bastionTransferTimeoutMs(BASTION_MAX_EVIDENCE_OBJECT_BYTES, BASTION_MIRROR_COPY_FLOOR_MS);
/** Copy time one mirror-objects call starts new copies within (a started copy may run past it). */
export const BASTION_MIRROR_TIME_BUDGET_MS = 20_000;
/**
 * How long the worker waits for one mirror-objects call: the budget, plus one copy of the largest
 * object started at its end, plus a minute for the source read and the bookkeeping.
 */
export const BASTION_MIRROR_CALL_TIMEOUT_MS = BASTION_MIRROR_TIME_BUDGET_MS + BASTION_MIRROR_MAX_COPY_MS + 60_000;

/** 200 `data` of the mirror-objects engine. `complete: false` means call again (the budget ran out). */
export const bastionMirrorResultSchema = z.object({
  status: BastionMirrorStatus,
  mirrored: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  removed_redacted: z.number().int().nonnegative(),
  seals_and_records: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  complete: z.boolean(),
  error: z.string().nullable().optional(),
});
export type BastionMirrorResult = z.infer<typeof bastionMirrorResultSchema>;

/** 200 `data` of the object-sweep engine. */
export const bastionObjectSweepResultSchema = z.object({
  checked: z.number().int().nonnegative(),
  removed_orphans: z.number().int().nonnegative(),
  cleared_intents: z.number().int().nonnegative(),
  deleted_redacted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  paused_orgs: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type BastionObjectSweepResult = z.infer<typeof bastionObjectSweepResultSchema>;

/** One personal-data holder whose commitment the packet records (spec 7.2). */
export const bastionCommitmentHolderSchema = z
  .object({
    holder_kind: BastionPersonalDataHolderKind,
    holder_id: z.string().uuid(),
  })
  .strict();
export type BastionCommitmentHolder = z.infer<typeof bastionCommitmentHolderSchema>;

/** Body of the verify-commitments engine: the HMAC key never leaves bastion-api. */
export const bastionVerifyCommitmentsEngineSchema = z
  .object({
    organization_id: z.string().uuid(),
    holders: z.array(bastionCommitmentHolderSchema).min(1).max(1000),
  })
  .strict();
export type BastionVerifyCommitmentsEngine = z.infer<typeof bastionVerifyCommitmentsEngineSchema>;

/** Per holder: whether the recorded names still match their commitment (spec 7.2). */
export const BastionCommitmentResult = z.enum(['intact', 'pd_mismatch', 'key_changed', 'redacted', 'no_personal_data']);
export type BastionCommitmentResult = z.infer<typeof BastionCommitmentResult>;

export const bastionVerifyCommitmentsResultSchema = z.object({
  results: z.array(
    z.object({
      holder_kind: BastionPersonalDataHolderKind,
      holder_id: z.string().uuid(),
      result: BastionCommitmentResult,
    }),
  ),
});
export type BastionVerifyCommitmentsResult = z.infer<typeof bastionVerifyCommitmentsResultSchema>;

const packetEngineBase = {
  organization_id: z.string().uuid(),
  packet_id: z.string().uuid(),
  claimant: z.string().min(1).max(128),
};

/** Body of the export-packet engine: the job's claim, progress, finish and fail calls. */
export const bastionExportPacketEngineSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim'), ...packetEngineBase }).strict(),
  z
    .object({
      action: z.literal('progress'),
      ...packetEngineBase,
      stage: BastionPacketStage,
      progress: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal('finish'),
      ...packetEngineBase,
      object_key: z.string().min(1).max(512),
      content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size_bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.literal('fail'), ...packetEngineBase, error: z.string().min(1).max(2000) }).strict(),
]);
export type BastionExportPacketEngine = z.infer<typeof bastionExportPacketEngineSchema>;

/** What the packet job writes, assembled by bastion-api on claim (one place for the rules). */
export const bastionPacketContentsSchema = z.object({
  packet: z.object({
    id: z.string().uuid(),
    organization_id: z.string().uuid(),
    period_start: z.string(),
    period_end: z.string(),
    include_restricted: z.boolean(),
    max_packet_bytes: z.number().int().positive(),
    object_key: z.string(),
  }),
  organization_name: z.string(),
  framework: z.object({ id: z.string().uuid(), name: z.string(), template_key: z.string(), is_iso: z.boolean() }),
  generated_at: z.string(),
  controls: z.array(
    z.object({
      control_key: z.string(),
      title: z.string(),
      category: z.string().nullable(),
      owner: z.string().nullable(),
      state: BastionRoomControlState,
      state_words: z.string(),
      reason: z.string().nullable(),
      requirement_codes: z.array(z.string()),
      last_evaluated_at: z.string().nullable(),
    }),
  ),
  evidence: z.array(
    z.object({
      snapshot_id: z.string().uuid(),
      control_key: z.string(),
      outcome: z.string(),
      reason: z.string().nullable(),
      recorded_at: z.string(),
      object_key: z.string().nullable(),
      content_sha256: z.string(),
      redacted: z.boolean(),
      path: z.string(),
    }),
  ),
  files: z.array(
    z.object({
      manual_evidence_id: z.string().uuid(),
      title: z.string(),
      kind: z.string(),
      control_keys: z.array(z.string()),
      object_key: z.string().nullable(),
      content_sha256: z.string().nullable(),
      size_bytes: z.number().int().nonnegative().nullable(),
      restricted: z.boolean(),
      redacted: z.boolean(),
      path: z.string(),
    }),
  ),
  attestations_csv: z.string(),
  exceptions_csv: z.string(),
  drift_csv: z.string(),
  soa_csv: z.string().nullable(),
  seals: z.array(z.record(z.unknown())),
  public_keys: z.array(z.object({ signing_key_id: z.string(), public_key_hex: z.string(), current: z.boolean() })),
  restore_notices: z.array(z.string()),
  holders: z.array(bastionCommitmentHolderSchema),
});
export type BastionPacketContents = z.infer<typeof bastionPacketContentsSchema>;

/** 200 `data` of export-packet `claim`: contents to write, or why the packet cannot be built. */
export const bastionPacketClaimSchema = z.object({
  claimed: z.boolean(),
  status: BastionExportStatus,
  error: z.string().nullable().optional(),
  contents: bastionPacketContentsSchema.nullable(),
  /**
   * Set when the packet is `running` under another attempt whose heartbeat is still fresh
   * (#326): milliseconds until that lease goes stale and this attempt may take it over. The
   * worker waits that long and claims again instead of dropping the job.
   */
  retry_after_ms: z.number().int().min(0).optional(),
});
export type BastionPacketClaim =z.infer<typeof bastionPacketClaimSchema>;

/* ------------------------------------------------------------------ */
/*  M10: search (spec 5.1 row 95, 8.5)                                 */
/* ------------------------------------------------------------------ */

/** GET /search?q= (row 95): controls and linked policies, read by the platform search_everything. */
export const bastionSearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(200),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type BastionSearchQuery = z.infer<typeof bastionSearchQuerySchema>;

export const BastionSearchEntityType = z.enum(['bastion.control', 'bastion.policy']);
export type BastionSearchEntityType = z.infer<typeof BastionSearchEntityType>;

/** One hit of GET /search: the entity_type is the can_access type, so search_everything can gate it. */
export const bastionSearchHitSchema = z.object({
  entity_type: BastionSearchEntityType,
  id: z.string().uuid(),
  title: z.string(),
  snippet: z.string(),
  score: z.number().min(0).max(1),
  url: z.string(),
});
export type BastionSearchHit = z.infer<typeof bastionSearchHitSchema>;

// ── Response rows (#348) ────────────────────────────────────────────────────────────────
// What the routes send, as JSON (timestamps are ISO strings), so bastion-api's services, the
// SPA and the MCP tools type the same fields from one place.

/** A drafted fix: GET /fix-drafts, GET /fix-drafts/:id, POST /gaps/:id/fix, POST /fix-drafts/:id/decide. */
export const bastionFixDraftSchema = z.object({
  id: z.string().uuid(),
  gap_id: z.string().uuid().nullable(),
  template: BastionFixTemplate,
  template_words: z.string(),
  title: z.string(),
  body_markdown: z.string().nullable(),
  payload: z.record(z.unknown()),
  cited_refs: z.array(bastionCitedRefSchema),
  dropped_citation_count: z.number().int(),
  hidden_citation_count: z.number().int(),
  proposal_id: z.string().uuid().nullable(),
  status: BastionFixDraftStatus,
  decided_by: z.string().uuid().nullable(),
  decided_by_name: z.string().nullable(),
  decided_at: z.string().nullable(),
  applied_entity_type: z.string().nullable(),
  applied_entity_id: z.string().nullable(),
  created_by: z.string().uuid().nullable(),
  created_by_name: z.string().nullable(),
  created_by_kind: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  gap_kind: BastionGapKind.nullable(),
  gap_words: z.string().nullable(),
  control_id: z.string().uuid().nullable(),
  control_title: z.string().nullable(),
  owner_user_id: z.string().uuid().nullable(),
  owner_name: z.string().nullable(),
  proposal_expires_at: z.string().nullable(),
});
export type BastionFixDraft = z.infer<typeof bastionFixDraftSchema>;

/** An exception: GET /exceptions, POST /exceptions, POST /exceptions/:id/decide. */
export const bastionExceptionSchema = z.object({
  id: z.string().uuid(),
  control_id: z.string().uuid(),
  control_title: z.string(),
  owner_user_id: z.string().uuid().nullable(),
  owner_name: z.string().nullable(),
  assertion_id: z.string().uuid().nullable(),
  assertion_statement: z.string().nullable(),
  scope: BastionExceptionScope,
  cited_entity_type: z.string().nullable(),
  cited_entity_id: z.string().nullable(),
  frozen_refs: z.array(bastionCitedRefSchema).nullable(),
  reason: z.string(),
  compensating_note: z.string().nullable(),
  proposal_id: z.string().uuid().nullable(),
  status: BastionExceptionStatus,
  proposed_by: z.string().uuid(),
  proposed_by_name: z.string().nullable(),
  decided_by: z.string().uuid().nullable(),
  decided_by_name: z.string().nullable(),
  decided_at: z.string().nullable(),
  small_team_self_approval: z.boolean(),
  approval_label: z.string().nullable(),
  expires_at: z.string(),
  days_left: z.number().int(),
  state_words: z.string().nullable(),
  ledger_seq: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type BastionException = z.infer<typeof bastionExceptionSchema>;

/** The lost range fields a restore row and a bucket restore record share. */
const bastionRestoreRangeFields = {
  id: z.string().uuid(),
  detected_at: z.string(),
  db_head_seq: z.number().int().nullable(),
  bucket_seal_date: z.string().nullable(),
  bucket_epoch: z.number().int().nullable(),
  bucket_head_seq: z.number().int().nullable(),
  lost_from_seq: z.number().int().nullable(),
  lost_to_seq: z.number().int().nullable(),
  provisional_epoch: z.number().int(),
  platform_restore_id: z.string().uuid().nullable(),
  status: BastionRestoreStatus,
  resolution: BastionRestoreResolution.nullable(),
  resolved_at: z.string().nullable(),
  label: z.enum(['History lost by restore', 'Unexplained gap']),
  summary: z.string(),
};

/** A database restore row of GET /ledger/restores. */
export const bastionRestoreRowSchema = z.object({
  ...bastionRestoreRangeFields,
  resolved_by: z.string().uuid().nullable(),
  appends_blocked: z.boolean(),
});
export type BastionRestoreRow = z.infer<typeof bastionRestoreRowSchema>;

/** A lost range the database no longer holds, read from a signed bucket record (#208). */
export const bastionBucketRestoreSchema = z.object({
  ...bastionRestoreRangeFields,
  record: z.literal('ledger_restore'),
  organization_id: z.string().uuid(),
  bucket_head_hash: z.string().nullable(),
  signing_key_id: z.string(),
  object_key: z.string(),
});
export type BastionBucketRestore = z.infer<typeof bastionBucketRestoreSchema>;

/** GET /ledger/restores. bucket_only, bucket_available and bucket_rejected are first-page facts. */
export const bastionRestoreListResponseSchema = z.object({
  data: z.array(bastionRestoreRowSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  bucket_only: z.array(bastionBucketRestoreSchema),
  bucket_available: z.boolean(),
  bucket_rejected: z.number().int(),
});
export type BastionRestoreListResponse = z.infer<typeof bastionRestoreListResponseSchema>;

// ── Response shapes, every route (#371) ─────────────────────────────────────────────────
// #348 moved three response shapes here; #371 moves the rest. Each schema is what the route sends
// as JSON (timestamps and dates are strings, bigint columns are numbers), derived from the
// service that builds it. bastion-api's services return these types (Served<T> in
// apps/bastion-api/src/lib/served.ts lets a service hold a Date where the wire has a string), the
// SPA's apps/bastion/src/lib/api.ts only aliases them (scripts/lib/bastion-spa-response-types
// .test.mjs fails on a hand-written copy), and the MCP bastion tools read responses through them.
// The objects are not strict: a schema lists what a client may rely on.

const ts = z.string();
const uuid = z.string().uuid();
/** A list's cursor; most Bastion lists are a single page and send null. */
const nextCursor = z.string().nullable();

/* ------------------------------- setup, frameworks, controls ------------------------------- */

/** A population check's list, with labels instead of raw ids (spec 6.2, #195). */
export const bastionPopulationViewSchema = z.object({
  kind: BastionPopulationKind,
  members: z.array(z.object({ value: z.string(), label: z.string() })),
  confirmed_at: z.string().nullable(),
  confirmed_by: z.string().nullable(),
});
export type BastionPopulationView = z.infer<typeof bastionPopulationViewSchema>;

/** One assertion (a "check"): assertionView in apps/bastion-api/src/services/controls.service.ts. */
export const bastionAssertionSchema = z.object({
  id: uuid,
  organization_id: uuid,
  control_id: uuid,
  kind: BastionAssertionKind,
  probe_key: z.string().nullable(),
  probe_version: z.number().int().nullable(),
  params: z.record(z.unknown()),
  predicate: z.record(z.unknown()),
  manual_evidence_spec: z
    .object({ title: z.string(), description: z.string(), kind: BastionManualEvidenceKind, cadence_days: z.number().int() })
    .nullable(),
  feed_id: uuid.nullable(),
  plain_statement: z.string(),
  proposed_by: BastionAssertionProposedBy,
  compile_run_id: uuid.nullable(),
  review_status: BastionAssertionReviewStatus,
  supersedes_id: uuid.nullable(),
  confirmed_by: uuid.nullable(),
  confirmed_at: ts.nullable(),
  created_by: uuid.nullable(),
  created_at: ts,
  updated_at: ts,
  probe_title: z.string().nullable(),
  probe_inherited: z.boolean(),
  population: bastionPopulationViewSchema.nullable(),
});
export type BastionAssertion = z.infer<typeof bastionAssertionSchema>;

/** A proposed check waiting for review in Setup: the assertion plus its control's title. */
export const bastionProposedCheckSchema = bastionAssertionSchema.extend({ control_title: z.string() });
export type BastionProposedCheck = z.infer<typeof bastionProposedCheckSchema>;

/** POST /controls/:id/assertions, /assertions/:id/revise|confirm|reject. */
export const bastionAssertionResponseSchema = z.object({ data: bastionAssertionSchema });
export type BastionAssertionResponse = z.infer<typeof bastionAssertionResponseSchema>;

/** GET /controls/:id/assertions. */
export const bastionAssertionListResponseSchema = z.object({ data: z.array(bastionAssertionSchema), next_cursor: nextCursor });
export type BastionAssertionListResponse = z.infer<typeof bastionAssertionListResponseSchema>;

/** How far an ISO framework's Statement of Applicability is (library/soa.ts soaCompleteness). */
export const bastionSoaCompletenessSchema = z.object({
  complete: z.boolean(),
  unmapped_ref_codes: z.array(z.string()),
  undecided_ref_codes: z.array(z.string()),
  decided_count: z.number().int(),
  requirement_count: z.number().int(),
});
export type BastionSoaCompleteness = z.infer<typeof bastionSoaCompletenessSchema>;

/** "N of M set up" (library/setup-state.ts setupCounts). */
export const bastionSetupCountsSchema = z.object({
  total: z.number().int(),
  set_up: z.number().int(),
  not_set_up: z.number().int(),
  not_applicable: z.number().int(),
});
export type BastionSetupCounts = z.infer<typeof bastionSetupCountsSchema>;

/** One compile run (a bastion_compile_runs row). */
export const bastionCompileRunSchema = z.object({
  id: uuid,
  organization_id: uuid,
  framework_id: uuid,
  status: BastionRunStatus,
  controls_total: z.number().int(),
  controls_done: z.number().int(),
  assertions_proposed: z.number().int(),
  assertions_dropped: z.number().int(),
  drop_reasons: z.record(z.unknown()),
  llm_calls_used: z.number().int(),
  used_fallback: z.boolean(),
  resume_count: z.number().int(),
  claimed_by: z.string().nullable(),
  heartbeat_at: ts.nullable(),
  slice_token: uuid.nullable(),
  error: z.string().nullable(),
  started_by: uuid.nullable(),
  started_at: ts.nullable(),
  completed_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionCompileRun = z.infer<typeof bastionCompileRunSchema>;

/** A bastion_frameworks row as the routes send it. */
export const bastionFrameworkRowSchema = z.object({
  id: uuid,
  organization_id: uuid,
  template_key: z.string(),
  template_version: z.string(),
  name: z.string(),
  status: BastionFrameworkStatus,
  audit_target_date: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  adopted_at: ts.nullable(),
  adopted_by: uuid.nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionFrameworkRow = z.infer<typeof bastionFrameworkRowSchema>;

/** One framework with its setup counts: GET /frameworks, GET /frameworks/:id. */
export const bastionFrameworkViewSchema = bastionFrameworkRowSchema.extend({
  is_iso: z.boolean(),
  requirement_count: z.number().int(),
  setup: bastionSetupCountsSchema,
  statement_of_applicability: bastionSoaCompletenessSchema.nullable(),
});
export type BastionFrameworkView = z.infer<typeof bastionFrameworkViewSchema>;

export const bastionFrameworkListResponseSchema = z.object({ data: z.array(bastionFrameworkViewSchema), next_cursor: nextCursor });
export type BastionFrameworkListResponse = z.infer<typeof bastionFrameworkListResponseSchema>;

export const bastionFrameworkResponseSchema = z.object({ data: bastionFrameworkViewSchema });
export type BastionFrameworkResponse = z.infer<typeof bastionFrameworkResponseSchema>;

/** POST /frameworks: the new framework row and what adopting it created. */
export const bastionAdoptFrameworkResponseSchema = z.object({
  data: bastionFrameworkRowSchema.extend({
    controls_created: z.number().int(),
    controls_reused: z.number().int(),
    controls_revived: z.number().int(),
    requirement_links: z.number().int(),
  }),
});
export type BastionAdoptFrameworkResponse = z.infer<typeof bastionAdoptFrameworkResponseSchema>;

/** PATCH /frameworks/:id. */
export const bastionFrameworkRowResponseSchema = z.object({ data: bastionFrameworkRowSchema });
export type BastionFrameworkRowResponse = z.infer<typeof bastionFrameworkRowResponseSchema>;

/** POST /frameworks/:id/archive. */
export const bastionArchiveFrameworkResponseSchema = z.object({ data: bastionFrameworkRowSchema.extend({ controls_retired: z.number().int() }) });
export type BastionArchiveFrameworkResponse = z.infer<typeof bastionArchiveFrameworkResponseSchema>;

/** One built-in template: GET /library/templates. */
export const bastionTemplateSummarySchema = z.object({
  template_key: z.string(),
  template_version: z.string(),
  name: z.string(),
  description: z.string(),
  is_iso: z.boolean(),
  requirement_count: z.number().int(),
  control_count: z.number().int(),
  adopted_framework_id: uuid.nullable(),
});
export type BastionTemplateSummary = z.infer<typeof bastionTemplateSummarySchema>;

export const bastionTemplateListResponseSchema = z.object({ data: z.array(bastionTemplateSummarySchema) });
export type BastionTemplateListResponse = z.infer<typeof bastionTemplateListResponseSchema>;

/** A framework in Setup: its view, its newest compile run, and the template's name. */
export const bastionSetupFrameworkSchema = bastionFrameworkViewSchema.extend({
  latest_compile_run: bastionCompileRunSchema.nullable(),
  template_name: z.string(),
});
export type BastionSetupFramework = z.infer<typeof bastionSetupFrameworkSchema>;

const populationMembers = z.array(z.object({ value: z.string(), label: z.string() }));

/** GET /setup: the wizard's whole state (setup.service.ts getSetup). */
export const bastionSetupViewSchema = z.object({
  frameworks: z.array(bastionSetupFrameworkSchema),
  company_profile: z.record(z.unknown()),
  compliance_project: z.object({ id: uuid, name: z.string(), archived: z.boolean() }).nullable(),
  remediation_tasks: BastionRemediationTasks,
  proposed_checks: z.array(bastionProposedCheckSchema),
  /** The connected sets a population check may list, by name (#195). */
  connected_populations: z.object({ github_repos: populationMembers, blip_apps: populationMembers }),
  steps: z.object({
    frameworks: z.object({ done: z.boolean() }),
    profile: z.object({ done: z.boolean(), answered: z.number().int(), total: z.number().int() }),
    compliance_project: z.object({ done: z.boolean() }),
    compile: z.object({ done: z.boolean() }),
    review: z.object({ done: z.boolean(), waiting: z.number().int(), populations_waiting: z.number().int() }),
    applicability: z.object({
      done: z.boolean(),
      frameworks: z.array(z.object({ framework_id: uuid, name: z.string(), decided: z.number().int(), total: z.number().int() })),
    }),
  }),
  complete: z.boolean(),
});
export type BastionSetupView = z.infer<typeof bastionSetupViewSchema>;

export const bastionSetupResponseSchema = z.object({ data: bastionSetupViewSchema });
export type BastionSetupResponse = z.infer<typeof bastionSetupResponseSchema>;

/** PATCH /setup/profile. */
export const bastionSaveProfileResponseSchema = z.object({ data: z.object({ company_profile: z.record(z.unknown()), answered: z.number().int() }) });
export type BastionSaveProfileResponse = z.infer<typeof bastionSaveProfileResponseSchema>;

/** POST /setup/compliance-project. */
export const bastionComplianceProjectResponseSchema = z.object({
  data: z.object({ compliance_project: z.object({ id: uuid, name: z.string(), archived: z.boolean() }) }),
});
export type BastionComplianceProjectResponse = z.infer<typeof bastionComplianceProjectResponseSchema>;

/** One requirement link with its control, as GET /frameworks/:id/requirements lists it. */
export const bastionRequirementLinkSchema = z.object({
  id: uuid,
  ref_code: z.string(),
  control_id: uuid,
  control_key: z.string(),
  control_title: z.string(),
  applicability: BastionRequirementApplicability,
  not_applicable_reason: z.string().nullable(),
  decided_at: ts.nullable(),
  decided_by: uuid.nullable(),
  source: BastionRequirementSource,
});
export type BastionRequirementLink = z.infer<typeof bastionRequirementLinkSchema>;

export const bastionRequirementRowSchema = z.object({
  ref_code: z.string(),
  title: z.string(),
  plain_summary: z.string(),
  applicability: z.enum(['applicable', 'not_applicable', 'undecided']),
  links: z.array(bastionRequirementLinkSchema),
});
export type BastionRequirementRow = z.infer<typeof bastionRequirementRowSchema>;

/** GET /frameworks/:id/requirements. */
export const bastionRequirementsResponseSchema = z.object({
  data: z.array(bastionRequirementRowSchema),
  framework: z.object({ id: uuid, name: z.string(), is_iso: z.boolean() }),
  statement_of_applicability: bastionSoaCompletenessSchema.nullable(),
});
export type BastionRequirementsResponse = z.infer<typeof bastionRequirementsResponseSchema>;

/** POST /frameworks/:id/applicability. */
export const bastionApplicabilityResponseSchema = z.object({
  data: z.object({ links_updated: z.number().int(), statement_of_applicability: bastionSoaCompletenessSchema.nullable() }),
});
export type BastionApplicabilityResponse = z.infer<typeof bastionApplicabilityResponseSchema>;

/** A bastion_control_requirements row: PATCH /control-requirements/:id. */
export const bastionControlRequirementRowSchema = z.object({
  id: uuid,
  organization_id: uuid,
  control_id: uuid,
  framework_id: uuid,
  ref_code: z.string(),
  requirement_title: z.string(),
  applicability: BastionRequirementApplicability,
  not_applicable_reason: z.string().nullable(),
  decided_by: uuid.nullable(),
  decided_at: ts.nullable(),
  source: BastionRequirementSource,
  removed_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionControlRequirementRow = z.infer<typeof bastionControlRequirementRowSchema>;

export const bastionControlRequirementResponseSchema = z.object({ data: bastionControlRequirementRowSchema });
export type BastionControlRequirementResponse = z.infer<typeof bastionControlRequirementResponseSchema>;

/** A bastion_controls row as the routes send it (the generated search column is left out). */
export const bastionControlRowSchema = z.object({
  id: uuid,
  organization_id: uuid,
  control_key: z.string(),
  title: z.string(),
  plain_summary: z.string().nullable(),
  category: z.string().nullable(),
  risk_weight: z.number().int(),
  owner_user_id: uuid.nullable(),
  lifecycle: BastionControlLifecycle,
  status: BastionStoredStatus,
  status_reason: z.string().nullable(),
  stale_reason: z.string().nullable(),
  consecutive_error_nights: z.number().int(),
  last_error_night: z.string().nullable(),
  coverage_kind: BastionCoverageKind,
  active_exception_count: z.number().int(),
  last_evaluated_at: ts.nullable(),
  status_changed_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionControlRow = z.infer<typeof bastionControlRowSchema>;

/** POST /controls, PATCH /controls/:id. */
export const bastionControlRowResponseSchema = z.object({ data: bastionControlRowSchema });
export type BastionControlRowResponse = z.infer<typeof bastionControlRowResponseSchema>;

/** One control in GET /controls. */
export const bastionControlListRowSchema = z.object({
  id: uuid,
  control_key: z.string(),
  title: z.string(),
  plain_summary: z.string().nullable(),
  category: z.string().nullable(),
  risk_weight: z.number().int(),
  owner_user_id: uuid.nullable(),
  lifecycle: BastionControlLifecycle,
  status: BastionStoredStatus,
  status_reason: z.string().nullable(),
  coverage_kind: BastionCoverageKind,
  setup_state: BastionSetupState.nullable(),
  derived_applicability: BastionRequirementApplicability,
  requirements: z.array(
    z.object({ id: uuid, framework_id: uuid, framework_name: z.string(), ref_code: z.string(), applicability: BastionRequirementApplicability }),
  ),
  assertion_counts: z.object({ proposed: z.number().int(), confirmed: z.number().int(), rejected: z.number().int() }),
});
export type BastionControlListRow = z.infer<typeof bastionControlListRowSchema>;

/** GET /controls. */
export const bastionControlsResponseSchema = z.object({
  data: z.array(bastionControlListRowSchema),
  counts: bastionSetupCountsSchema,
  framework_id: uuid.nullable(),
  next_cursor: nextCursor,
});
export type BastionControlsResponse = z.infer<typeof bastionControlsResponseSchema>;

/** One live requirement link on a control, with its framework (controls.service.ts orgLinks). */
export const bastionControlLinkSchema = z.object({
  id: uuid,
  control_id: uuid,
  framework_id: uuid,
  framework_name: z.string(),
  framework_status: BastionFrameworkStatus,
  ref_code: z.string(),
  requirement_title: z.string(),
  applicability: BastionRequirementApplicability,
  not_applicable_reason: z.string().nullable(),
  decided_at: ts.nullable(),
  source: BastionRequirementSource,
  removed_at: ts.nullable(),
});
export type BastionControlLink = z.infer<typeof bastionControlLinkSchema>;

/** GET /controls/:id. */
export const bastionControlDetailSchema = bastionControlRowSchema.extend({
  setup_state: BastionSetupState.nullable(),
  derived_applicability: BastionRequirementApplicability,
  requirements: z.array(bastionControlLinkSchema),
  assertions: z.array(bastionAssertionSchema),
});
export type BastionControlDetail = z.infer<typeof bastionControlDetailSchema>;

export const bastionControlDetailResponseSchema = z.object({ data: bastionControlDetailSchema });
export type BastionControlDetailResponse = z.infer<typeof bastionControlDetailResponseSchema>;

/* ------------------------------- readiness and the evidence map ------------------------------- */

/** A framework the Readiness and Evidence map pages can narrow to. */
export const bastionFrameworkOptionSchema = z.object({
  id: uuid,
  template_key: z.string(),
  name: z.string(),
  audit_target_date: z.string().nullable(),
});
export type BastionFrameworkOption = z.infer<typeof bastionFrameworkOptionSchema>;

/** A not-applicable control, named for the "Not applicable" list. */
export const bastionNotApplicableControlSchema = z.object({ control_id: uuid, control_key: z.string(), title: z.string() });
export type BastionNotApplicableControl = z.infer<typeof bastionNotApplicableControlSchema>;

/** GET /summary `data` (coverage.service.ts readinessSummary). */
export const bastionSummarySchema = z.object({
  frameworks: z.array(bastionFrameworkOptionSchema),
  selected: bastionFrameworkOptionSchema.extend({ status: BastionFrameworkStatus }).nullable(),
  nearest_audit_date: z.string().nullable(),
  days_to_audit: z.number().int().nullable(),
  numbers: bastionReadinessNumbersSchema,
  headline: z.string(),
  not_met_label: z.string(),
  not_applicable: z.array(bastionNotApplicableControlSchema),
  banners: z.array(z.object({ code: BastionReadinessBanner, message: z.string(), count: z.number().int().optional() })),
  top_gaps: z.array(
    z.object({
      id: uuid,
      control_id: uuid,
      control_title: z.string(),
      gap_kind: BastionGapKind,
      risk_score: z.number(),
      fix_template: BastionFixTemplate.nullable(),
      fix_cost: z.number().int().nullable(),
    }),
  ),
  gaps_ranked: z.boolean(),
  expiring_evidence: z.array(
    z.object({ id: uuid, title: z.string(), owner_name: z.string().nullable(), valid_until: ts, days_left: z.number().int() }),
  ),
  last_full_run_at: ts.nullable(),
  timezone: z.string(),
  as_of: ts,
});
export type BastionSummary = z.infer<typeof bastionSummarySchema>;

export const bastionSummaryResponseSchema = z.object({ data: bastionSummarySchema });
export type BastionSummaryResponse = z.infer<typeof bastionSummaryResponseSchema>;

/** Evidence counts by source column (the Evidence map's columns). */
export const bastionSourceColumnsSchema = z.object({
  native: z.number().int(),
  feed: z.number().int(),
  manual_file: z.number().int(),
  self_attested: z.number().int(),
});
export type BastionSourceColumns = z.infer<typeof bastionSourceColumnsSchema>;

/** One control on the Evidence map (coverage.service.ts coverageMap). */
export const bastionCoverageRowSchema = z.object({
  control_id: uuid,
  control_key: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  owner_name: z.string().nullable(),
  set_up: z.boolean(),
  bucket: z.enum(['proven_by_suite', 'proven_by_evidence', 'not_met', 'cant_prove', 'not_set_up']),
  state: BastionEffectiveState.nullable(),
  state_words: z.string(),
  reason: BastionUnprovableReason.nullable(),
  reason_words: z.string().nullable(),
  risk_accepted: z.boolean(),
  columns: bastionSourceColumnsSchema,
  coverage_kind: BastionCoverageKind,
  manual_expires_at: ts.nullable(),
  manual_days_left: z.number().int().nullable(),
  last_evaluated_at: ts.nullable(),
});
export type BastionCoverageRow = z.infer<typeof bastionCoverageRowSchema>;

/** GET /coverage. */
export const bastionCoverageResponseSchema = z.object({
  data: z.array(bastionCoverageRowSchema),
  totals: bastionSourceColumnsSchema.extend({ none: z.number().int() }),
  numbers: bastionReadinessNumbersSchema,
  headline: z.string(),
  not_applicable: z.array(bastionNotApplicableControlSchema),
  frameworks: z.array(bastionFrameworkOptionSchema),
});
export type BastionCoverageResponse = z.infer<typeof bastionCoverageResponseSchema>;

/* ------------------------------- manual evidence and feeds ------------------------------- */

/** One assertion a manual-evidence item is linked to, and its review. */
export const bastionManualEvidenceLinkViewSchema = z.object({
  assertion_id: uuid,
  control_id: uuid,
  control_title: z.string(),
  plain_statement: z.string(),
  review_verdict: BastionReviewVerdict,
  reviewed_by: uuid.nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: ts.nullable(),
  review_note: z.string().nullable(),
  small_team_self_review: z.boolean(),
  linked_at: ts,
});
export type BastionManualEvidenceLinkView = z.infer<typeof bastionManualEvidenceLinkViewSchema>;

/** One manual-evidence item (manual-evidence.service.ts shape); masked when restricted and unreadable. */
export const bastionManualEvidenceItemSchema = z.object({
  id: uuid,
  kind: BastionManualEvidenceKind,
  title: z.string(),
  description: z.string().nullable(),
  source_system: z.string().nullable(),
  content_sha256: z.string().nullable(),
  size_bytes: z.number().int().nullable(),
  content_type: z.string().nullable(),
  scan_label: BastionScanLabel.nullable(),
  owner_user_id: uuid.nullable(),
  owner_name: z.string().nullable(),
  uploaded_by: uuid,
  uploaded_by_name: z.string().nullable(),
  produced_on: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  valid_until: ts.nullable(),
  sensitivity: BastionEvidenceSensitivity,
  status: BastionManualEvidenceStatus,
  blocked_reason: BastionManualEvidenceBlockedReason.nullable(),
  attempts: z.number().int(),
  next_attempt_at: ts.nullable(),
  superseded_by_id: uuid.nullable(),
  withdrawn_reason: z.string().nullable(),
  withdrawn_at: ts.nullable(),
  redacted_at: ts.nullable(),
  ledger_seq: z.number().int().nullable(),
  created_at: ts,
  updated_at: ts,
  personal_data_id: uuid.nullable(),
  restricted: z.boolean(),
  masked: z.boolean(),
  trust_label: z.string(),
  scan_note: z.string().nullable(),
  days_left: z.number().int().nullable(),
  stuck_scan: z.boolean(),
  links: z.array(bastionManualEvidenceLinkViewSchema),
});
export type BastionManualEvidenceItem = z.infer<typeof bastionManualEvidenceItemSchema>;

/** GET /manual-evidence/:id, POST /manual-evidence, POST /manual-evidence/:id/supersede. */
export const bastionManualEvidenceResponseSchema = z.object({ data: bastionManualEvidenceItemSchema });
export type BastionManualEvidenceResponse = z.infer<typeof bastionManualEvidenceResponseSchema>;

/** POST /manual-evidence/:id/check-again: the item and what the check found. */
export const bastionCheckScanAgainResponseSchema = z.object({ data: bastionManualEvidenceItemSchema.extend({ check_result: z.string() }) });
export type BastionCheckScanAgainResponse = z.infer<typeof bastionCheckScanAgainResponseSchema>;

/** GET /manual-evidence. */
export const bastionManualEvidenceListResponseSchema = z.object({
  data: z.array(bastionManualEvidenceItemSchema),
  counts: z.object({
    active: z.number().int(),
    pending_scan: z.number().int(),
    stuck: z.number().int(),
    blocked: z.number().int(),
    not_scanned: z.number().int(),
  }),
  next_cursor: nextCursor,
});
export type BastionManualEvidenceListResponse = z.infer<typeof bastionManualEvidenceListResponseSchema>;

/** POST /manual-evidence/:id/links/:assertion_id/unlink. */
export const bastionManualEvidenceUnlinkResponseSchema = z.object({
  data: z.object({ manual_evidence_id: uuid, assertion_id: uuid, unlinked: z.literal(true), reevaluating: z.boolean() }),
});
export type BastionManualEvidenceUnlinkResponse = z.infer<typeof bastionManualEvidenceUnlinkResponseSchema>;

/** POST /manual-evidence/:id/withdraw. */
export const bastionManualEvidenceWithdrawResponseSchema = z.object({
  data: z.object({ manual_evidence_id: uuid, status: z.literal('withdrawn'), reevaluating_controls: z.number().int() }),
});
export type BastionManualEvidenceWithdrawResponse = z.infer<typeof bastionManualEvidenceWithdrawResponseSchema>;

/** POST /personal-data/:id/redact. */
export const bastionRedactResponseSchema = z.object({
  data: z.object({
    personal_data_id: uuid,
    holder_kind: BastionPersonalDataHolderKind,
    holder_id: uuid,
    redacted: z.literal(true),
    bytes_deleted: z.boolean(),
    bytes_delete_pending: z.boolean(),
    reevaluating_controls: z.number().int(),
  }),
});
export type BastionRedactResponse = z.infer<typeof bastionRedactResponseSchema>;

/** One machine feed (feeds.service.ts shapeFeed). */
export const bastionFeedSchema = z.object({
  id: uuid,
  feed_key: z.string(),
  label: z.string(),
  feed_kind: z.string().nullable(),
  source_kind: BastionFeedSourceKind,
  bolt_source: z.string().nullable(),
  bolt_event_type: z.string().nullable(),
  cadence_days: z.number().int(),
  daily_record_quota: z.number().int(),
  quota_day: z.string().nullable(),
  records_on_quota_day: z.number().int(),
  bytes_total: z.number().int(),
  status: BastionFeedStatus,
  last_record_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
  /** Only GET /feeds counts these. */
  active_keys: z.number().int().optional(),
  record_count: z.number().int().optional(),
  records_today: z.number().int(),
  quota_remaining_today: z.number().int(),
  fresh: z.boolean(),
  freshness: z.string(),
});
export type BastionFeed = z.infer<typeof bastionFeedSchema>;

export const bastionFeedListResponseSchema = z.object({ data: z.array(bastionFeedSchema), next_cursor: nextCursor });
export type BastionFeedListResponse = z.infer<typeof bastionFeedListResponseSchema>;

/** POST /feeds, PATCH /feeds/:id. */
export const bastionFeedResponseSchema = z.object({ data: bastionFeedSchema });
export type BastionFeedResponse = z.infer<typeof bastionFeedResponseSchema>;

/** One feed key, never its secret (GET /feeds/:id/keys). */
export const bastionFeedKeySchema = z.object({
  id: uuid,
  feed_id: uuid,
  key_id: z.string(),
  fingerprint: z.string().nullable(),
  last4: z.string().nullable(),
  label: z.string().nullable(),
  status: BastionFeedKeyStatus,
  grace_expires_at: ts.nullable(),
  predecessor_id: uuid.nullable(),
  created_by: uuid.nullable(),
  created_at: ts,
  last_used_at: ts.nullable(),
  revoked_at: ts.nullable(),
  usable: z.boolean(),
});
export type BastionFeedKey = z.infer<typeof bastionFeedKeySchema>;

export const bastionFeedKeyListResponseSchema = z.object({ data: z.array(bastionFeedKeySchema) });
export type BastionFeedKeyListResponse = z.infer<typeof bastionFeedKeyListResponseSchema>;

/** POST /feeds/:id/keys: the token is in this response and nowhere else. */
export const bastionMintedFeedKeySchema = z.object({
  id: uuid,
  feed_id: uuid,
  key_id: z.string(),
  fingerprint: z.string(),
  last4: z.string(),
  label: z.string().nullable(),
  status: z.literal('active'),
  created_at: ts,
  token: z.string(),
  rotated_keys: z.number().int(),
  grace_expires_at: ts.nullable(),
  push_path: z.string(),
});
export type BastionMintedFeedKey = z.infer<typeof bastionMintedFeedKeySchema>;

export const bastionMintedFeedKeyResponseSchema = z.object({ data: bastionMintedFeedKeySchema });
export type BastionMintedFeedKeyResponse = z.infer<typeof bastionMintedFeedKeyResponseSchema>;

/** POST /feed-keys/:id/revoke. */
export const bastionRevokedFeedKeyResponseSchema = z.object({ data: z.object({ id: uuid, status: z.literal('revoked'), revoked_at: ts }) });
export type BastionRevokedFeedKeyResponse = z.infer<typeof bastionRevokedFeedKeyResponseSchema>;

/** One feed record (GET /feeds/:id/records); the subject is personal data, null once redacted. */
export const bastionFeedRecordRowSchema = z.object({
  id: uuid,
  idempotency_key: z.string(),
  occurred_at: ts,
  received_at: ts,
  payload_sha256: z.string(),
  ledger_seq: z.number().int().nullable(),
  personal_data_id: uuid.nullable(),
  redacted_at: ts.nullable(),
  subject: z.string().nullable(),
});
export type BastionFeedRecordRow = z.infer<typeof bastionFeedRecordRowSchema>;

export const bastionFeedRecordListResponseSchema = z.object({
  data: z.array(bastionFeedRecordRowSchema),
  next_cursor: nextCursor,
  has_more: z.boolean(),
});
export type BastionFeedRecordListResponse = z.infer<typeof bastionFeedRecordListResponseSchema>;

/* ------------------------------- gaps, drift, evidence snapshots ------------------------------- */

/** One stored gap (fixes.service.ts listGaps). */
export const bastionGapRowSchema = z.object({
  id: uuid,
  control_id: uuid,
  control_title: z.string(),
  owner_name: z.string().nullable(),
  assertion_id: uuid.nullable(),
  assertion_statement: z.string().nullable(),
  gap_kind: BastionGapKind,
  gap_words: z.string(),
  risk_score: z.number(),
  fix_template: BastionFixTemplate.nullable(),
  fix_words: z.string().nullable(),
  fix_cost: z.number().int().nullable(),
  status: BastionGapStatus,
  dismissed_reason: z.string().nullable(),
  latest_fix_draft_id: uuid.nullable(),
  computed_at: ts,
});
export type BastionGapRow = z.infer<typeof bastionGapRowSchema>;

/** An active exception shown under "Accepted risks" on the Gaps page. */
export const bastionAcceptedRiskSchema = z.object({
  id: uuid,
  control_id: uuid,
  control_title: z.string(),
  scope: BastionExceptionScope,
  reason: z.string(),
  expires_at: ts,
  owner_name: z.string().nullable(),
  approved_by_name: z.string().nullable(),
  small_team_self_approval: z.boolean(),
  approval_label: z.string().nullable(),
});
export type BastionAcceptedRisk = z.infer<typeof bastionAcceptedRiskSchema>;

/** GET /gaps. `stale` is the org-level row derived at read time (spec 2.3). */
export const bastionGapsResponseSchema = z.object({
  data: z.array(bastionGapRowSchema),
  stale: z
    .object({ gap_kind: z.literal(BASTION_STALE_GAP_KIND), gap_words: z.string(), control_count: z.number().int(), message: z.string() })
    .nullable(),
  accepted_risks: z.array(bastionAcceptedRiskSchema),
  sort: z.enum(['risk', 'quick_wins']),
  next_cursor: nextCursor,
});
export type BastionGapsResponse = z.infer<typeof bastionGapsResponseSchema>;

/** POST /gaps/:id/dismiss. */
export const bastionGapDismissResponseSchema = z.object({ data: z.object({ id: uuid, status: z.literal('dismissed'), dismissed_reason: z.string() }) });
export type BastionGapDismissResponse = z.infer<typeof bastionGapDismissResponseSchema>;

/** GET /fix-drafts. */
export const bastionFixDraftListResponseSchema = z.object({ data: z.array(bastionFixDraftSchema), next_cursor: nextCursor });
export type BastionFixDraftListResponse = z.infer<typeof bastionFixDraftListResponseSchema>;

/** GET /fix-drafts/:id, POST /gaps/:id/propose-fix, POST /fix-drafts/:id/decide|mark-applied. */
export const bastionFixDraftResponseSchema = z.object({ data: bastionFixDraftSchema });
export type BastionFixDraftResponse = z.infer<typeof bastionFixDraftResponseSchema>;

/** GET /exceptions. */
export const bastionExceptionListResponseSchema = z.object({ data: z.array(bastionExceptionSchema), next_cursor: nextCursor });
export type BastionExceptionListResponse = z.infer<typeof bastionExceptionListResponseSchema>;

/** GET /exceptions/:id, POST /exceptions, POST /exceptions/:id/decide. */
export const bastionExceptionResponseSchema = z.object({ data: bastionExceptionSchema });
export type BastionExceptionResponse = z.infer<typeof bastionExceptionResponseSchema>;

/** One drift event (drift.service.ts listDrift). */
export const bastionDriftRowSchema = z.object({
  id: uuid,
  control_id: uuid,
  control_title: z.string(),
  evaluation_run_id: uuid.nullable(),
  exception_id: uuid.nullable(),
  from_status: z.string(),
  to_status: z.string(),
  reason: z.string(),
  task_status: BastionDriftTaskStatus,
  bam_task_id: uuid.nullable(),
  bam_task_human_id: z.string().nullable(),
  acknowledged_by: uuid.nullable(),
  acknowledged_by_name: z.string().nullable(),
  acknowledged_at: ts.nullable(),
  detected_at: ts,
  from_words: z.string(),
  to_words: z.string(),
  reason_words: z.string(),
  task_words: z.string(),
});
export type BastionDriftRow = z.infer<typeof bastionDriftRowSchema>;

/** GET /drift: newest first; next_cursor is the last row's detected_at (pass it as `before`). */
export const bastionDriftListResponseSchema = z.object({ data: z.array(bastionDriftRowSchema), has_more: z.boolean(), next_cursor: nextCursor });
export type BastionDriftListResponse = z.infer<typeof bastionDriftListResponseSchema>;

/** POST /drift/:id/acknowledge. */
export const bastionDriftAcknowledgeResponseSchema = z.object({ data: z.object({ id: uuid, acknowledged_by: uuid, acknowledged_at: ts }) });
export type BastionDriftAcknowledgeResponse = z.infer<typeof bastionDriftAcknowledgeResponseSchema>;

/**
 * One evidence snapshot as a reader sees it (evidence.service.ts present + withVisibleRefs):
 * counts-only unless detail_visible, citations re-checked for the reader.
 */
export const bastionEvidenceSnapshotSchema = z.object({
  id: uuid,
  evaluation_run_id: uuid,
  assertion_id: uuid,
  control_id: uuid,
  outcome: BastionStoredStatus,
  unprovable_reason: z.string().nullable(),
  probe_key: z.string().nullable(),
  probe_version: z.number().int().nullable(),
  params: z.record(z.unknown()),
  query_fingerprint: z.string().nullable(),
  population_checked: z.array(z.string()).nullable(),
  population_unlisted: z.array(z.string()).nullable(),
  population_hidden_count: z.number().int(),
  window_start: ts.nullable(),
  window_end: ts.nullable(),
  summary: z.record(z.unknown()),
  cited_refs: z.array(bastionCitedRefSchema),
  overflow_count: z.number().int(),
  manual_evidence_ids: z.array(uuid),
  exception_ids: z.array(uuid),
  feed_record_count: z.number().int(),
  replica_lag_ms: z.number().int().nullable(),
  content_sha256: z.string().nullable(),
  ledger_seq: z.number().int().nullable(),
  created_at: ts,
  explanation: z.string().nullable(),
  detail_visible: z.boolean(),
  hidden_citation_count: z.number().int(),
  /** Plain names of the cited items (detail readers only), e.g. "PR #42 in rescue-radio-firmware: ...". */
  cited_labels: z.array(z.string()),
  cited_items: z.array(z.object({ entity_type: z.string(), entity_id: z.string(), label: z.string().nullable() })),
});
export type BastionEvidenceSnapshot = z.infer<typeof bastionEvidenceSnapshotSchema>;

/** GET /controls/:id/evidence. */
export const bastionEvidenceSnapshotListResponseSchema = z.object({
  data: z.array(bastionEvidenceSnapshotSchema),
  has_more: z.boolean(),
  next_cursor: nextCursor,
});
export type BastionEvidenceSnapshotListResponse = z.infer<typeof bastionEvidenceSnapshotListResponseSchema>;

/** GET /evidence/:id. */
export const bastionEvidenceSnapshotResponseSchema = z.object({ data: bastionEvidenceSnapshotSchema });
export type BastionEvidenceSnapshotResponse = z.infer<typeof bastionEvidenceSnapshotResponseSchema>;

/* ------------------------------- policies ------------------------------- */

/** One policy (policies.service.ts shapePolicy). Live article facts only for who may open it (#236). */
export const bastionPolicyRowSchema = z.object({
  id: uuid,
  beacon_entry_id: uuid,
  title: z.string(),
  audience: bastionPolicyAudienceSchema,
  cadence_days: z.number().int(),
  owner_user_id: uuid.nullable(),
  owner_name: z.string().nullable(),
  status: BastionPolicyStatus,
  beacon_status: z.string().nullable(),
  visibility: z.string().nullable(),
  shared_with_everyone: z.boolean(),
  sharing_problem: z.string().nullable(),
  current_version: z.number().int().nullable(),
  expires_at: ts.nullable(),
  days_to_expiry: z.number().int().nullable(),
  last_verified_at: ts.nullable(),
  required_people: z.number().int(),
  attested_count: z.number().int(),
  not_attested_count: z.number().int(),
  attestation_label: z.string().nullable(),
  /** Only 'current' can be acknowledged (#244); null when the viewer may not see the article's state (#296). */
  article_state: BastionPolicyArticleState.nullable(),
  /** What the owner should do when the article is missing, retired or expired. */
  article_problem: z.string().nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionPolicyRow = z.infer<typeof bastionPolicyRowSchema>;

export const bastionPolicyListResponseSchema = z.object({ data: z.array(bastionPolicyRowSchema), next_cursor: nextCursor });
export type BastionPolicyListResponse = z.infer<typeof bastionPolicyListResponseSchema>;

/** GET /policies/:id, PATCH /policies/:id. */
export const bastionPolicyResponseSchema = z.object({ data: bastionPolicyRowSchema });
export type BastionPolicyResponse = z.infer<typeof bastionPolicyResponseSchema>;

/**
 * POST /policies: the policy and the checks it proposed for the control it was linked to.
 * pin_problem is set when the policy was linked but its checks could not be pinned (#393): the
 * link still succeeded, so the caller must not retry it.
 */
export const bastionPolicyCreateResponseSchema = z.object({
  data: bastionPolicyRowSchema.extend({ proposed_assertion_ids: z.array(uuid), pin_problem: z.string().nullable() }),
});
export type BastionPolicyCreateResponse = z.infer<typeof bastionPolicyCreateResponseSchema>;

/** GET /policies/:id/attestations. */
export const bastionPolicyAttestationsSchema = z.object({
  policy: bastionPolicyRowSchema,
  attested: z.array(z.object({ user_id: uuid, name: z.string(), attested_at: ts })),
  not_attested: z.array(z.object({ user_id: uuid, name: z.string(), can_open: z.boolean() })),
  cannot_open_count: z.number().int(),
  cannot_open_label: z.string().nullable(),
});
export type BastionPolicyAttestations = z.infer<typeof bastionPolicyAttestationsSchema>;

export const bastionPolicyAttestationsResponseSchema = z.object({ data: bastionPolicyAttestationsSchema });
export type BastionPolicyAttestationsResponse = z.infer<typeof bastionPolicyAttestationsResponseSchema>;

/** GET /policies/:id/body: the frozen current version, and where the reader stands. */
export const bastionPolicyBodySchema = z.object({
  policy_id: uuid,
  beacon_entry_id: uuid,
  title: z.string(),
  beacon_version: z.number().int(),
  body_markdown: z.string(),
  body_sha256: z.string(),
  saved_at: ts,
  expires_at: ts.nullable(),
  cadence_days: z.number().int(),
  in_audience: z.boolean(),
  attested_at: ts.nullable(),
  due: z.boolean(),
});
export type BastionPolicyBody = z.infer<typeof bastionPolicyBodySchema>;

export const bastionPolicyBodyResponseSchema = z.object({ data: bastionPolicyBodySchema });
export type BastionPolicyBodyResponse = z.infer<typeof bastionPolicyBodyResponseSchema>;

/** One row of GET /me/attestations. */
export const bastionMyAttestationRowSchema = z.object({
  policy_id: uuid,
  title: z.string(),
  current_version: z.number().int().nullable(),
  shared_with_everyone: z.boolean(),
  due: z.boolean(),
  /** Nothing can be read or acknowledged right now (the article is not current) (#296). */
  paused: z.boolean(),
  /** Whether the article can be read and acknowledged (#244); null when the reader may not see it (#296). */
  article_state: BastionPolicyArticleState.nullable(),
  state_words: z.string(),
  last_attested_version: z.number().int().nullable(),
  last_attested_at: ts.nullable(),
  next_due_at: ts.nullable(),
});
export type BastionMyAttestationRow = z.infer<typeof bastionMyAttestationRowSchema>;

export const bastionMyAttestationsResponseSchema = z.object({ data: z.array(bastionMyAttestationRowSchema) });
export type BastionMyAttestationsResponse = z.infer<typeof bastionMyAttestationsResponseSchema>;

/** POST /policies/:id/request-attestations. */
export const bastionRequestAttestationsResponseSchema = z.object({
  data: z.object({ policy_id: uuid, due: z.number().int(), asked: z.number().int(), nudged: z.number().int(), already_nudged_today: z.number().int() }),
});
export type BastionRequestAttestationsResponse = z.infer<typeof bastionRequestAttestationsResponseSchema>;

/* ------------------------------- questionnaires ------------------------------- */

/** One questionnaire (questionnaires.service.ts shapeQuestionnaire). */
export const bastionQuestionnaireSchema = z.object({
  id: uuid,
  title: z.string(),
  requester_label: z.string().nullable(),
  bond_deal_id: uuid.nullable(),
  bond_company_id: uuid.nullable(),
  source_bin_asset_id: uuid.nullable(),
  source_bin_asset_version_id: uuid.nullable(),
  source_sha256: z.string().nullable(),
  format: BastionQuestionnaireFormat,
  status: BastionQuestionnaireStatus,
  injection_suspected: z.boolean(),
  row_count: z.number().int(),
  rows_done: z.number().int(),
  low_count: z.number().int(),
  medium_count: z.number().int(),
  high_count: z.number().int(),
  resume_count: z.number().int(),
  llm_calls_used: z.number().int(),
  ai_failure_streak: z.number().int(),
  autofill_use_ai: z.boolean(),
  due_date: z.string().nullable(),
  owner_user_id: uuid.nullable(),
  owner_name: z.string().nullable(),
  drafting_now: z.boolean(),
  approved_by: uuid.nullable(),
  approved_by_name: z.string().nullable(),
  approved_at: ts.nullable(),
  created_by: uuid.nullable(),
  created_by_name: z.string().nullable(),
  created_at: ts,
  updated_at: ts,
  column_map: z.object({ sheets: z.array(bastionQuestionnaireSheetMapSchema), guessed: z.boolean() }).nullable(),
  source_truncated: z.boolean(),
  /** Only GET /questionnaires/:id (and the routes that answer with it) carry the preview. */
  sheet_preview: z
    .array(z.object({ name: z.string(), row_count: z.number().int(), column_count: z.number().int(), rows: z.array(z.array(z.string())) }))
    .optional(),
  counts_label: z.string().nullable(),
});
export type BastionQuestionnaire = z.infer<typeof bastionQuestionnaireSchema>;

export const bastionQuestionnaireListResponseSchema = z.object({ data: z.array(bastionQuestionnaireSchema), next_cursor: nextCursor });
export type BastionQuestionnaireListResponse = z.infer<typeof bastionQuestionnaireListResponseSchema>;

/** GET /questionnaires/:id and every route that changes one (create, update, autofill, approve). */
export const bastionQuestionnaireResponseSchema = z.object({ data: bastionQuestionnaireSchema });
export type BastionQuestionnaireResponse = z.infer<typeof bastionQuestionnaireResponseSchema>;

/** A citation chip on an answer: a control or policy the reader may see, by name. */
export const bastionQuestionnaireCitationSchema = z.object({
  entity_type: z.string(),
  entity_id: z.string(),
  label: z.string().nullable(),
  state_words: z.string().nullable().optional(),
});
export type BastionQuestionnaireCitation = z.infer<typeof bastionQuestionnaireCitationSchema>;

/** One question and its answer (questionnaires.service.ts shapeItems). */
export const bastionQuestionnaireItemSchema = z.object({
  id: uuid,
  questionnaire_id: uuid,
  sheet_name: z.string(),
  row_index: z.number().int(),
  section: z.string().nullable(),
  question_text: z.string(),
  answer_kind: BastionAnswerKind,
  draft_answer: z.string().nullable(),
  draft_yes_no: z.boolean().nullable(),
  final_answer: z.string().nullable(),
  final_yes_no: z.boolean().nullable(),
  cited_refs: z.array(bastionQuestionnaireCitationSchema),
  dropped_citation_count: z.number().int(),
  hidden_citation_count: z.number().int(),
  confidence: z.number().nullable(),
  confidence_band: BastionConfidenceBand.nullable(),
  confidence_words: z.string().nullable(),
  band_reasons: z.array(z.object({ code: z.string(), words: z.string() })),
  review_status: BastionItemReviewStatus,
  assigned_to: uuid.nullable(),
  assigned_to_name: z.string().nullable(),
  reviewed_by: uuid.nullable(),
  reviewed_by_name: z.string().nullable(),
  reviewed_at: ts.nullable(),
  needs_review: z.boolean(),
});
export type BastionQuestionnaireItem = z.infer<typeof bastionQuestionnaireItemSchema>;

/** What still blocks approval (spec 2.7 step 7). */
export const bastionQuestionnaireApprovalSchema = z.object({
  low_unreviewed: z.number().int(),
  waiting_on_owner: z.number().int(),
  undrafted: z.number().int(),
  medium_unreviewed: z.number().int(),
  can_approve: z.boolean(),
  blocked_because: z.array(z.string()),
});
export type BastionQuestionnaireApproval = z.infer<typeof bastionQuestionnaireApprovalSchema>;

/** GET /questionnaires/:id/items. */
export const bastionQuestionnaireItemsResponseSchema = z.object({
  data: z.array(bastionQuestionnaireItemSchema),
  approval: bastionQuestionnaireApprovalSchema,
  next_cursor: nextCursor,
});
export type BastionQuestionnaireItemsResponse = z.infer<typeof bastionQuestionnaireItemsResponseSchema>;

/** PATCH /questionnaire-items/:id: the reviewed answer and the questionnaire's blockers after it. */
export const bastionQuestionnaireItemReviewResponseSchema = z.object({ data: bastionQuestionnaireItemSchema, approval: bastionQuestionnaireApprovalSchema });
export type BastionQuestionnaireItemReviewResponse = z.infer<typeof bastionQuestionnaireItemReviewResponseSchema>;

/** One approved answer in the answer library (questionnaires.service.ts shapeLibrary). */
export const bastionAnswerLibraryRowSchema = z.object({
  id: uuid,
  question_text: z.string(),
  answer_text: z.string(),
  yes_no: z.boolean().nullable(),
  cited_refs: z.array(bastionQuestionnaireCitationSchema),
  hidden_citation_count: z.number().int(),
  source_item_id: uuid.nullable(),
  approved_by: uuid.nullable(),
  approved_by_name: z.string().nullable(),
  approved_at: ts.nullable(),
  stale: z.boolean(),
  stale_reason: z.string().nullable(),
  stale_words: z.string().nullable(),
  retired_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
  rank: z.number(),
});
export type BastionAnswerLibraryRow = z.infer<typeof bastionAnswerLibraryRowSchema>;

export const bastionAnswerLibraryListResponseSchema = z.object({ data: z.array(bastionAnswerLibraryRowSchema), next_cursor: nextCursor });
export type BastionAnswerLibraryListResponse = z.infer<typeof bastionAnswerLibraryListResponseSchema>;

/** PATCH /answer-library/:id. */
export const bastionAnswerLibraryResponseSchema = z.object({ data: bastionAnswerLibraryRowSchema });
export type BastionAnswerLibraryResponse = z.infer<typeof bastionAnswerLibraryResponseSchema>;

/* ------------------------------- sharing: auditor rooms, requests, packets ------------------------------- */

export const BastionRoomState = z.enum(['active', 'expired', 'revoked', 'locked']);
export type BastionRoomState = z.infer<typeof BastionRoomState>;

/** One auditor room on the creator's side (sharing.service.ts roomOut); never its token. */
export const bastionAuditorRoomSchema = z.object({
  id: uuid,
  label: z.string(),
  framework_id: uuid.nullable(),
  framework_name: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  expires_at: ts,
  revoked_at: ts.nullable(),
  locked_at: ts.nullable(),
  state: BastionRoomState,
  has_passcode: z.boolean(),
  passcode_failures: z.number().int(),
  link_hint: z.string().nullable(),
  control_count: z.number().int(),
  restricted_count: z.number().int(),
  access_count: z.number().int(),
  last_accessed_at: ts.nullable(),
  open_requests: z.number().int(),
  created_by_name: z.string().nullable(),
  created_at: ts,
});
export type BastionAuditorRoom = z.infer<typeof bastionAuditorRoomSchema>;

export const bastionAuditorRoomListResponseSchema = z.object({ data: z.array(bastionAuditorRoomSchema), next_cursor: nextCursor });
export type BastionAuditorRoomListResponse = z.infer<typeof bastionAuditorRoomListResponseSchema>;

/** POST /auditor-rooms/:id/revoke|unlock. */
export const bastionAuditorRoomResponseSchema = z.object({ data: bastionAuditorRoomSchema });
export type BastionAuditorRoomResponse = z.infer<typeof bastionAuditorRoomResponseSchema>;

/** POST /auditor-rooms: the room plus its link, shown once. */
export const bastionCreatedAuditorRoomSchema = bastionAuditorRoomSchema.extend({ token: z.string(), link: z.string(), token_notice: z.string() });
export type BastionCreatedAuditorRoom = z.infer<typeof bastionCreatedAuditorRoomSchema>;

export const bastionCreatedAuditorRoomResponseSchema = z.object({ data: bastionCreatedAuditorRoomSchema });
export type BastionCreatedAuditorRoomResponse = z.infer<typeof bastionCreatedAuditorRoomResponseSchema>;

/** One visit in a room's access log: what, when, which visitor, which device (never the raw address). */
export const bastionAccessLogRowSchema = z.object({
  id: uuid,
  accessed_at: ts,
  view_kind: BastionAuditorViewKind,
  what: z.string(),
  visitor: z.string(),
  device: z.string(),
});
export type BastionAccessLogRow = z.infer<typeof bastionAccessLogRowSchema>;

/** GET /auditor-rooms/:id/access-log. */
export const bastionAccessLogResponseSchema = z.object({
  data: z.array(bastionAccessLogRowSchema),
  room: bastionAuditorRoomSchema,
  has_more: z.boolean(),
  next_cursor: nextCursor,
});
export type BastionAccessLogResponse = z.infer<typeof bastionAccessLogResponseSchema>;

/** One auditor question (GET /auditor-requests). */
export const bastionAuditorRequestSchema = z.object({
  id: uuid,
  room_id: uuid,
  room_label: z.string(),
  control_id: uuid.nullable(),
  control_title: z.string().nullable(),
  requester_name: z.string().nullable(),
  body: z.string(),
  status: BastionAuditorRequestStatus,
  answer_note: z.string().nullable(),
  answered_by_name: z.string().nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionAuditorRequest = z.infer<typeof bastionAuditorRequestSchema>;

export const bastionAuditorRequestListResponseSchema = z.object({ data: z.array(bastionAuditorRequestSchema), next_cursor: nextCursor });
export type BastionAuditorRequestListResponse = z.infer<typeof bastionAuditorRequestListResponseSchema>;

/** PATCH /auditor-requests/:id: the same row the list shows. */
export const bastionAuditorRequestResponseSchema = z.object({ data: bastionAuditorRequestSchema });
export type BastionAuditorRequestResponse = z.infer<typeof bastionAuditorRequestResponseSchema>;

/** One audit packet (GET /exports). */
export const bastionExportPacketSchema = z.object({
  id: uuid,
  framework_id: uuid.nullable(),
  framework_name: z.string().nullable(),
  period_start: z.string(),
  period_end: z.string(),
  include_restricted: z.boolean(),
  status: BastionExportStatus,
  stage: z.string().nullable(),
  stage_progress: z.number().int(),
  stage_words: z.string().nullable(),
  size_bytes: z.number().int().nullable(),
  error: z.string().nullable(),
  requested_by_name: z.string().nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionExportPacket = z.infer<typeof bastionExportPacketSchema>;

export const bastionExportListResponseSchema = z.object({ data: z.array(bastionExportPacketSchema), next_cursor: nextCursor });
export type BastionExportListResponse = z.infer<typeof bastionExportListResponseSchema>;

/** POST /exports: the queued packet (the same row the list shows) and whether the worker was told. */
export const bastionExportCreateResponseSchema = z.object({ data: bastionExportPacketSchema.extend({ queued_for_worker: z.boolean() }) });
export type BastionExportCreateResponse = z.infer<typeof bastionExportCreateResponseSchema>;

/** One control as an auditor sees it (audit-view.ts auditControls); `id` is the control id. */
export const bastionRoomControlSchema = z.object({
  id: uuid,
  control_id: uuid,
  control_key: z.string(),
  title: z.string(),
  category: z.string().nullable(),
  owner: z.string().nullable(),
  state: BastionRoomControlState,
  state_words: z.string(),
  reason: z.string().nullable(),
  requirement_codes: z.array(z.string()),
  last_evaluated_at: ts.nullable(),
});
export type BastionRoomControl = z.infer<typeof bastionRoomControlSchema>;

/** An accepted risk as an auditor sees it (audit-view.ts acceptedRisks). */
export const bastionRoomRiskSchema = z.object({
  id: uuid,
  control_key: z.string(),
  control_title: z.string(),
  reason: z.string(),
  compensating_note: z.string().nullable(),
  expires_at: ts,
  owner: z.string().nullable(),
});
export type BastionRoomRisk = z.infer<typeof bastionRoomRiskSchema>;

/** One Statement of Applicability row (library/soa.ts soaRows). */
export const bastionSoaRowSchema = z.object({
  ref_code: z.string(),
  title: z.string(),
  applicable: z.enum(['Yes', 'No', 'Not decided']),
  justification: z.string(),
  implementing_controls: z.string(),
  current_status: z.string(),
});
export type BastionSoaRow = z.infer<typeof bastionSoaRowSchema>;

/**
 * What an auditor sees on opening a room (sharing.service.ts roomOverview): GET /public/room and
 * the creator's GET /auditor-rooms/:id/preview, which adds `state`.
 */
export const bastionRoomOverviewSchema = z.object({
  room: z.object({
    label: z.string(),
    organization_name: z.string(),
    framework_name: z.string().nullable(),
    is_iso: z.boolean(),
    period_start: z.string().nullable(),
    period_end: z.string().nullable(),
    expires_at: ts,
  }),
  numbers: z.object({
    met: z.number().int(),
    not_met: z.number().int(),
    risk_accepted: z.number().int(),
    cant_prove: z.number().int(),
    not_assessed: z.number().int(),
    total: z.number().int(),
  }),
  controls: z.array(bastionRoomControlSchema),
  accepted_risks: z.array(bastionRoomRiskSchema),
  restricted_items: z.array(z.object({ id: uuid, title: z.string() })),
  statement_of_applicability: z.array(bastionSoaRowSchema).nullable(),
  seals: z.array(
    z.object({
      seal_date: z.string(),
      epoch: z.number().int(),
      head_seq: z.number().int(),
      head_hash: z.string(),
      signature: z.string(),
      signing_key_id: z.string(),
    }),
  ),
  public_keys: z.array(z.object({ signing_key_id: z.string(), public_key_hex: z.string(), current: z.boolean() })),
  notices: z.array(z.string()),
  not_an_audit: z.string(),
  /** The creator's Preview only. */
  state: BastionRoomState.optional(),
});
export type BastionRoomOverview = z.infer<typeof bastionRoomOverviewSchema>;

export const bastionRoomOverviewResponseSchema = z.object({ data: bastionRoomOverviewSchema });
export type BastionRoomOverviewResponse = z.infer<typeof bastionRoomOverviewResponseSchema>;

/** A manual-evidence item as an auditor sees it (room.service.ts fileOut). */
export const bastionRoomFileSchema = z.object({
  id: uuid,
  kind: z.enum(['file', 'statement']),
  title: z.string(),
  description: z.string().nullable(),
  source_system: z.string().nullable(),
  produced_on: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  valid_until: ts.nullable(),
  restricted: z.boolean(),
  review: z.string(),
  scan: z.string().nullable(),
  superseded: z.boolean(),
});
export type BastionRoomFile = z.infer<typeof bastionRoomFileSchema>;

/** One check result as an auditor sees it: counts-only, no cited item ever leaves. */
export const bastionRoomCheckSchema = z.object({
  id: uuid,
  recorded_at: ts,
  what: z.string().nullable(),
  outcome: BastionStoredStatus,
  outcome_words: z.string(),
  explanation: z.string().nullable(),
});
export type BastionRoomCheck = z.infer<typeof bastionRoomCheckSchema>;

/** GET /public/room/controls/:id. */
export const bastionRoomControlDetailSchema = z.object({
  control: bastionRoomControlSchema,
  requirements: z.array(z.object({ ref_code: z.string(), title: z.string().nullable() })),
  evidence: z.array(bastionRoomCheckSchema),
  files: z.array(bastionRoomFileSchema),
  accepted_risks: z.array(bastionRoomRiskSchema),
});
export type BastionRoomControlDetail = z.infer<typeof bastionRoomControlDetailSchema>;

export const bastionRoomControlDetailResponseSchema = z.object({ data: bastionRoomControlDetailSchema });
export type BastionRoomControlDetailResponse = z.infer<typeof bastionRoomControlDetailResponseSchema>;

const roomEvidenceFile = {
  file: z.enum(['available', 'missing', 'redacted', 'none']),
  file_words: z.string().nullable(),
};

/** GET /public/room/evidence/:id: a check, or a manual-evidence file or statement. */
export const bastionRoomEvidenceDetailSchema = z.discriminatedUnion('kind', [
  bastionRoomCheckSchema.extend({ kind: z.literal('check'), control_title: z.string(), ...roomEvidenceFile }),
  bastionRoomFileSchema.extend({ kind: z.literal('file'), ...roomEvidenceFile }),
  bastionRoomFileSchema.extend({ kind: z.literal('statement'), ...roomEvidenceFile }),
]);
export type BastionRoomEvidenceDetail = z.infer<typeof bastionRoomEvidenceDetailSchema>;

export const bastionRoomEvidenceDetailResponseSchema = z.object({ data: bastionRoomEvidenceDetailSchema });
export type BastionRoomEvidenceDetailResponse = z.infer<typeof bastionRoomEvidenceDetailResponseSchema>;

/** POST /public/room/requests. */
export const bastionPublicRoomRequestResponseSchema = z.object({
  data: z.object({ id: uuid, status: BastionAuditorRequestStatus, created_at: ts, message: z.string() }),
});
export type BastionPublicRoomRequestResponse = z.infer<typeof bastionPublicRoomRequestResponseSchema>;

/* ------------------------------- settings and delivery problems ------------------------------- */

/** GET /settings `data` (settings.service.ts getSettings). */
export const bastionSettingsViewSchema = z.object({
  settings: z.object({
    remediation_tasks: BastionRemediationTasks,
    timezone: z.string(),
    evaluation_hour_local: z.number().int(),
    llm_provider_id: uuid.nullable(),
    stale_after_hours: z.number().int(),
    not_assessed_grace_days: z.number().int(),
    manual_expiry_warn_days: z.number().int(),
    questionnaire_high_floor: z.number(),
    questionnaire_medium_floor: z.number(),
    max_llm_calls_per_compile: z.number().int(),
    max_llm_calls_per_questionnaire: z.number().int(),
    max_rows_per_questionnaire: z.number().int(),
    auditor_room_max_days: z.number().int(),
    max_packet_bytes: z.number().int(),
  }),
  compliance_project: z.object({ id: uuid, name: z.string().nullable() }).nullable(),
  ai_providers: z.array(z.object({ id: uuid, name: z.string(), model: z.string(), scope: z.string(), is_default: z.boolean() })),
  evidence_integrity: z.object({
    seal_keys: z.array(z.object({ fingerprint: z.string(), current: z.boolean() })),
    personal_data_key: z.string(),
    restores_awaiting: z.array(
      z.object({
        id: uuid,
        detected_at: ts,
        status: BastionRestoreStatus,
        lost_from_seq: z.number().int().nullable(),
        lost_to_seq: z.number().int().nullable(),
        bucket_epoch: z.number().int().nullable(),
        provisional_epoch: z.number().int(),
      }),
    ),
  }),
  offsite_backup: z.object({
    configured: z.boolean(),
    last_backup_at: ts.nullable(),
    last_mirror_status: z.string().nullable(),
    current_through: ts.nullable(),
  }),
  storage_ok: z.boolean(),
  delivery_problems: z.number().int(),
  updated_at: ts,
});
export type BastionSettingsView = z.infer<typeof bastionSettingsViewSchema>;

/** GET /settings, PATCH /settings. */
export const bastionSettingsResponseSchema = z.object({ data: bastionSettingsViewSchema });
export type BastionSettingsResponse = z.infer<typeof bastionSettingsResponseSchema>;

/** One delivery that gave up (a dead outbox row), in plain words. */
export const bastionDeliveryProblemSchema = z.object({
  id: uuid,
  what: z.string(),
  event: z.string().nullable(),
  attempts: z.number().int(),
  retried_before: z.number().int(),
  last_error: z.string().nullable(),
  created_at: ts,
});
export type BastionDeliveryProblem = z.infer<typeof bastionDeliveryProblemSchema>;

export const bastionDeliveryProblemListResponseSchema = z.object({ data: z.array(bastionDeliveryProblemSchema), next_cursor: nextCursor });
export type BastionDeliveryProblemListResponse = z.infer<typeof bastionDeliveryProblemListResponseSchema>;

/** One row of GET /audit (bastion_audit_log, with names). */
export const bastionAuditLogRowSchema = z.object({
  id: uuid,
  created_at: ts,
  action: z.string(),
  subject_type: z.string().nullable(),
  subject_id: uuid.nullable(),
  actor_id: uuid.nullable(),
  actor_kind: z.string().nullable(),
  impersonator_id: uuid.nullable(),
  details: z.record(z.unknown()),
  actor_name: z.string().nullable(),
  impersonator_name: z.string().nullable(),
});
export type BastionAuditLogRow = z.infer<typeof bastionAuditLogRowSchema>;

/** GET /audit: newest first, cursor-paginated. */
export const bastionAuditLogResponseSchema = z.object({ data: z.array(bastionAuditLogRowSchema), has_more: z.boolean(), next_cursor: nextCursor });
export type BastionAuditLogResponse = z.infer<typeof bastionAuditLogResponseSchema>;

/* ------------------------------- evaluations, compile runs, the ledger ------------------------------- */

/** One evaluation run (bastion_evaluation_runs). */
export const bastionEvaluationRunSchema = z.object({
  id: uuid,
  trigger: BastionEvaluationTrigger,
  scope: BastionEvaluationScope,
  control_id: uuid.nullable(),
  nightly_for_date: z.string().nullable(),
  as_of: ts,
  status: BastionRunStatus,
  partial_reason: z.string().nullable(),
  resume_count: z.number().int(),
  controls_total: z.number().int(),
  controls_done: z.number().int(),
  pass_count: z.number().int(),
  fail_count: z.number().int(),
  unprovable_count: z.number().int(),
  started_by: uuid.nullable(),
  started_at: ts.nullable(),
  completed_at: ts.nullable(),
  created_at: ts,
  updated_at: ts,
});
export type BastionEvaluationRun = z.infer<typeof bastionEvaluationRunSchema>;

/** GET /evaluations. */
export const bastionEvaluationListResponseSchema = z.object({ data: z.array(bastionEvaluationRunSchema), has_more: z.boolean(), next_cursor: nextCursor });
export type BastionEvaluationListResponse = z.infer<typeof bastionEvaluationListResponseSchema>;

/** GET /evaluations/:id. */
export const bastionEvaluationResponseSchema = z.object({ data: bastionEvaluationRunSchema });
export type BastionEvaluationResponse = z.infer<typeof bastionEvaluationResponseSchema>;

/** POST /evaluations (202): the queued run and whether the worker was told. */
export const bastionStartEvaluationResponseSchema = z.object({ data: bastionEvaluationRunSchema.extend({ enqueued: z.boolean() }) });
export type BastionStartEvaluationResponse = z.infer<typeof bastionStartEvaluationResponseSchema>;

/** GET /frameworks/:id/compile-runs. */
export const bastionCompileRunListResponseSchema = z.object({ data: z.array(bastionCompileRunSchema), has_more: z.boolean(), next_cursor: nextCursor });
export type BastionCompileRunListResponse = z.infer<typeof bastionCompileRunListResponseSchema>;

/** POST /frameworks/:id/compile (202): the run, queued for the worker (AI) or already finished (library). */
export const bastionCompileRunResponseSchema = z.object({ data: bastionCompileRunSchema });
export type BastionCompileRunResponse = z.infer<typeof bastionCompileRunResponseSchema>;

/** One daily seal (GET /ledger/seals). */
export const bastionSealRowSchema = z.object({
  seal_date: z.string(),
  epoch: z.number().int(),
  head_seq: z.number().int(),
  head_hash: z.string(),
  signature: z.string(),
  signing_key_id: z.string(),
  object_written_at: ts.nullable(),
  published_at: ts.nullable(),
});
export type BastionSealRow = z.infer<typeof bastionSealRowSchema>;

/** GET /ledger/seals: the seals, every key that signed one, and how a seal is signed. */
export const bastionSealListResponseSchema = z.object({
  data: z.array(bastionSealRowSchema),
  has_more: z.boolean(),
  next_cursor: nextCursor,
  signing_keys: z.array(z.object({ signing_key_id: z.string(), public_key_hex: z.string(), current: z.boolean() })),
  canonical_form: z.string(),
});
export type BastionSealListResponse = z.infer<typeof bastionSealListResponseSchema>;

/** POST /evidence/:id/verify. */
export const bastionVerifyEvidenceResponseSchema = z.object({
  data: z.object({
    evidence_id: uuid,
    result: BastionVerificationResult,
    content_sha256: z.string().nullable(),
    ledger: z.object({ epoch: z.number().int(), seq: z.number().int(), entry_hash: z.string() }).nullable(),
    seal: z
      .object({
        seal_date: z.string(),
        head_seq: z.number().int(),
        signing_key_id: z.string(),
        signature_valid: z.boolean(),
        chain_intact: z.boolean(),
      })
      .nullable(),
    notes: z.array(z.string()),
  }),
});
export type BastionVerifyEvidenceResponse = z.infer<typeof bastionVerifyEvidenceResponseSchema>;

/** POST /ledger/restores/:id/acknowledge. */
export const bastionRestoreAcknowledgeResponseSchema = z.object({
  data: z.object({
    id: uuid,
    status: BastionRestoreStatus,
    resolution: BastionRestoreResolution,
    provisional_epoch: z.number().int().nullable(),
    first_seq: z.number().int().nullable(),
  }),
});
export type BastionRestoreAcknowledgeResponse = z.infer<typeof bastionRestoreAcknowledgeResponseSchema>;

/** POST /policies/:id/attest: the attestation (idempotent: created is false on a repeat). */
export const bastionAttestResponseSchema = z.object({
  data: z.object({
    id: uuid,
    policy_id: uuid,
    beacon_version: z.number().int(),
    body_sha256: z.string(),
    attested_at: ts,
    ledger_seq: z.number().int().nullable(),
    created: z.boolean(),
    rechecking_controls: z.number().int(),
  }),
});
export type BastionAttestResponse = z.infer<typeof bastionAttestResponseSchema>;

/** POST /feeds/:feed_key/records (the machine push). */
export const bastionFeedIngestResponseSchema = z.object({
  data: z.object({ accepted: z.number().int(), duplicates: z.number().int(), quota_remaining: z.number().int() }),
});
export type BastionFeedIngestResponse = z.infer<typeof bastionFeedIngestResponseSchema>;

/** POST /delivery-problems/:id/retry. */
export const bastionDeliveryRetryResponseSchema = z.object({
  data: z.object({ id: uuid, result: z.enum(['retrying', 'superseded']), message: z.string() }),
});
export type BastionDeliveryRetryResponse = z.infer<typeof bastionDeliveryRetryResponseSchema>;
