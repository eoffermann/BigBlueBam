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
