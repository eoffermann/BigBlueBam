import { z } from 'zod';

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

/** POST /frameworks/:id/compile. M3 runs the deterministic compile only (spec 2.1 step 5). */
export const bastionCompileFrameworkSchema = z.object({}).strict();
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

/** 200 `data` of POST /internal/engines/evaluate-tick. */
export const bastionEvaluateTickResultSchema = z.object({ runs: z.array(bastionTickRunSchema) });
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
    stuck: z.coerce.boolean().optional(),
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

/** POST /fix-drafts/:id/mark-applied (row 57). */
export const bastionFixMarkAppliedSchema = z
  .object({
    applied_entity_type: BastionFixAppliedEntityType.nullable().optional(),
    applied_entity_id: z.string().uuid().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => !!b.applied_entity_type === !!b.applied_entity_id, {
    message: 'Give both the kind of thing you made and its id, or neither',
    path: ['applied_entity_id'],
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
    cited_entity_type: z
      .string()
      .regex(/^[a-z]+\.[a-z_]+$/, 'Use an entity type like bam.api_key')
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
    unacknowledged: z.coerce.boolean().optional(),
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
