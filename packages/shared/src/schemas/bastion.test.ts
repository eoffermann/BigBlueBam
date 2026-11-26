import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  BASTION_PROBE_KEYS,
  BastionAnswerKind,
  BastionAssertionProposedBy,
  BastionAssertionReviewStatus,
  BastionAuditorRequestStatus,
  BastionAuditorViewKind,
  BastionConfidenceBand,
  BastionCoverageKind,
  BastionDriftTaskStatus,
  BastionEvaluationScope,
  BastionEvaluationTrigger,
  BastionEvidenceSensitivity,
  BastionExceptionScope,
  BastionExceptionStatus,
  BastionExportStatus,
  BastionFeedKeyStatus,
  BastionFeedSourceKind,
  BastionFeedStatus,
  BastionFixDraftStatus,
  BastionFixTemplate,
  BastionFrameworkStatus,
  BastionGapKind,
  BastionGapStatus,
  BastionIngestStatus,
  BastionItemReviewStatus,
  BastionLedgerEntryKind,
  BastionManualEvidenceKind,
  BastionManualEvidenceStatus,
  BastionOutboxKind,
  BastionOutboxStatus,
  BastionPersonalDataHolderKind,
  BastionPolicyStatus,
  BastionQuestionnaireFormat,
  BastionQuestionnaireStatus,
  BastionRestoreResolution,
  BastionRestoreStatus,
  BastionReviewVerdict,
  BastionRunStatus,
  BastionScanLabel,
  BastionStoredStatus,
  BastionStoredUnprovableReason,
  BastionUnprovableReason,
  BASTION_FIX_TEMPLATE_COST,
  BASTION_GAP_SEVERITY,
  bastionFeedBatchSchema,
  bastionFeedRecordSchema,
  bastionPolicyAudienceSchema,
  bastionProbeFunctionName,
} from './bastion.js';

// The Bastion enums mirror CHECK constraints in migrations 0274-0278. This suite reads the
// migration files and fails when the two drift apart, so a new status value cannot land in
// one place only (fix the fact, not the place).

const MIGRATIONS_DIR = join(__dirname, '../../../../infra/postgres/migrations');
const bastionSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_bastion_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
  .join('\n');

/** The literal values a constraint allows for one column: `<column> IN ('a', 'b', ...)`. */
function checkValues(constraint: string, column: string): string[] {
  const start = bastionSql.indexOf(`ADD CONSTRAINT ${constraint}`);
  if (start < 0) throw new Error(`constraint ${constraint} not found in the bastion migrations`);
  const body = bastionSql.slice(start, bastionSql.indexOf(';', start));
  const m = body.match(new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`));
  if (!m) throw new Error(`${constraint} has no "${column} IN (...)" list`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

const CASES: Array<[string, string, z.ZodEnum<[string, ...string[]]>]> = [
  ['bastion_frameworks_status_check', 'status', BastionFrameworkStatus],
  ['bastion_controls_status_check', 'status', BastionStoredStatus],
  ['bastion_controls_status_reason_check', 'status_reason', BastionStoredUnprovableReason],
  ['bastion_controls_coverage_kind_check', 'coverage_kind', BastionCoverageKind],
  ['bastion_assertions_proposed_by_check', 'proposed_by', BastionAssertionProposedBy],
  ['bastion_assertions_review_status_check', 'review_status', BastionAssertionReviewStatus],
  ['bastion_compile_runs_status_check', 'status', BastionRunStatus],
  ['bastion_evaluation_runs_shape_check', 'trigger', BastionEvaluationTrigger],
  ['bastion_evaluation_runs_shape_check', 'scope', BastionEvaluationScope],
  ['bastion_evaluation_runs_shape_check', 'status', BastionRunStatus],
  ['bastion_evidence_snapshots_outcome_check', 'outcome', BastionStoredStatus],
  ['bastion_manual_evidence_shape_check', 'kind', BastionManualEvidenceKind],
  ['bastion_manual_evidence_shape_check', 'scan_label', BastionScanLabel],
  ['bastion_manual_evidence_shape_check', 'sensitivity', BastionEvidenceSensitivity],
  ['bastion_manual_evidence_shape_check', 'status', BastionManualEvidenceStatus],
  ['bastion_manual_evidence_links_verdict_check', 'review_verdict', BastionReviewVerdict],
  ['bastion_evidence_feeds_shape_check', 'source_kind', BastionFeedSourceKind],
  ['bastion_evidence_feeds_shape_check', 'status', BastionFeedStatus],
  ['bastion_feed_keys_status_check', 'status', BastionFeedKeyStatus],
  ['bastion_personal_data_shape_check', 'holder_kind', BastionPersonalDataHolderKind],
  ['bastion_ingest_events_status_check', 'status', BastionIngestStatus],
  ['bastion_outbox_shape_check', 'kind', BastionOutboxKind],
  ['bastion_outbox_shape_check', 'status', BastionOutboxStatus],
  ['bastion_ledger_entries_shape_check', 'entry_kind', BastionLedgerEntryKind],
  ['bastion_ledger_restores_shape_check', 'status', BastionRestoreStatus],
  ['bastion_ledger_restores_shape_check', 'resolution', BastionRestoreResolution],
  ['bastion_drift_events_task_status_check', 'task_status', BastionDriftTaskStatus],
  ['bastion_gaps_shape_check', 'gap_kind', BastionGapKind],
  ['bastion_gaps_shape_check', 'fix_template', BastionFixTemplate],
  ['bastion_gaps_shape_check', 'status', BastionGapStatus],
  ['bastion_fix_drafts_shape_check', 'template', BastionFixTemplate],
  ['bastion_fix_drafts_shape_check', 'status', BastionFixDraftStatus],
  ['bastion_exceptions_shape_check', 'scope', BastionExceptionScope],
  ['bastion_exceptions_shape_check', 'status', BastionExceptionStatus],
  ['bastion_policies_shape_check', 'status', BastionPolicyStatus],
  ['bastion_questionnaires_shape_check', 'format', BastionQuestionnaireFormat],
  ['bastion_questionnaires_shape_check', 'status', BastionQuestionnaireStatus],
  ['bastion_questionnaire_items_shape_check', 'answer_kind', BastionAnswerKind],
  ['bastion_questionnaire_items_shape_check', 'confidence_band', BastionConfidenceBand],
  ['bastion_questionnaire_items_shape_check', 'review_status', BastionItemReviewStatus],
  ['bastion_auditor_access_log_view_kind_check', 'view_kind', BastionAuditorViewKind],
  ['bastion_auditor_requests_status_check', 'status', BastionAuditorRequestStatus],
  ['bastion_export_packets_status_check', 'status', BastionExportStatus],
];

describe('Bastion enums match the migration CHECK constraints', () => {
  for (const [constraint, column, schema] of CASES) {
    it(`${constraint}.${column}`, () => {
      expect(checkValues(constraint, column)).toEqual([...schema.options].sort());
    });
  }
});

describe('Bastion vocabulary', () => {
  it('has exactly the 12 stored gap kinds of spec 2.3, each with a severity rule', () => {
    expect(BastionGapKind.options).toHaveLength(12);
    for (const kind of BastionGapKind.options) {
      if (kind === 'manual_expiring') continue; // computed from days left
      expect(BASTION_GAP_SEVERITY[kind], kind).toBeGreaterThan(0);
    }
  });

  it('prices every fix template', () => {
    for (const t of BastionFixTemplate.options) expect(BASTION_FIX_TEMPLATE_COST[t]).toBeGreaterThan(0);
  });

  it('adds only the computed evaluation_stale to the stored unprovable reasons', () => {
    expect(BastionUnprovableReason.options.filter((r) => !BastionStoredUnprovableReason.options.includes(r as never))).toEqual(['evaluation_stale']);
  });

  it('has a hardened v1 definer function in migration 0279 for every probe key', () => {
    expect(BASTION_PROBE_KEYS).toHaveLength(20);
    for (const key of BASTION_PROBE_KEYS) {
      const fn = bastionProbeFunctionName(key, 1);
      expect(bastionSql, fn).toContain(`CREATE OR REPLACE FUNCTION ${fn}(`);
    }
    expect(bastionProbeFunctionName('keys.max_age', 1)).toBe('bastion_probe_keys_max_age_v1');
  });
});

describe('Bastion feed and audience contracts', () => {
  it('accepts a minimal feed record and rejects unknown keys', () => {
    const ok = { idempotency_key: 'crew-roster:2026-11-01', occurred_at: '2026-11-01T00:00:00Z' };
    expect(bastionFeedRecordSchema.safeParse(ok).success).toBe(true);
    expect(bastionFeedRecordSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('caps a batch at 500 records', () => {
    const rec = { idempotency_key: 'k', occurred_at: '2026-11-01T00:00:00Z' };
    expect(bastionFeedBatchSchema.safeParse({ records: Array(500).fill(rec) }).success).toBe(true);
    expect(bastionFeedBatchSchema.safeParse({ records: Array(501).fill(rec) }).success).toBe(false);
  });

  it('parses both policy audience shapes', () => {
    expect(bastionPolicyAudienceSchema.safeParse({ kind: 'all' }).success).toBe(true);
    expect(
      bastionPolicyAudienceSchema.safeParse({
        kind: 'users',
        user_ids: ['00000000-0000-0000-0000-0000000000b5'],
      }).success,
    ).toBe(true);
    expect(bastionPolicyAudienceSchema.safeParse({ kind: 'users', user_ids: [] }).success).toBe(false);
  });
});
