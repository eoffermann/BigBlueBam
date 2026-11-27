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
  BastionControlLifecycle,
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
  BastionRemediationTasks,
  BastionRequirementApplicability,
  BastionRequirementSource,
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
  bastionDriftListQuerySchema,
  bastionFixMarkAppliedSchema,
  bastionPolicyCreateSchema,
} from './bastion.js';

describe('pasted links name things by id or Beacon slug (#232, #239)', () => {
  const ID = '0b5e0000-0000-4000-8000-00000000b001';
  it('mark-applied: a type with an id or (Beacon only) a slug, never both, never a slug for Bolt', () => {
    expect(bastionFixMarkAppliedSchema.safeParse({ applied_entity_type: 'bolt.rule', applied_entity_id: ID }).success).toBe(true);
    expect(bastionFixMarkAppliedSchema.safeParse({ applied_entity_type: 'beacon.entry', applied_entity_slug: 'Island-Policy' }).data).toMatchObject({
      applied_entity_slug: 'island-policy',
    });
    expect(bastionFixMarkAppliedSchema.safeParse({}).success).toBe(true);
    expect(bastionFixMarkAppliedSchema.safeParse({ applied_entity_type: 'bolt.rule', applied_entity_slug: 'x' }).success).toBe(false);
    expect(bastionFixMarkAppliedSchema.safeParse({ applied_entity_type: 'beacon.entry', applied_entity_id: ID, applied_entity_slug: 'x' }).success).toBe(false);
    expect(bastionFixMarkAppliedSchema.safeParse({ applied_entity_type: 'beacon.entry' }).success).toBe(false);
  });
  it('policy create: exactly one of beacon_entry_id and beacon_slug', () => {
    expect(bastionPolicyCreateSchema.safeParse({ beacon_slug: 'island-information-security-policy' }).success).toBe(true);
    expect(bastionPolicyCreateSchema.safeParse({ beacon_entry_id: ID }).success).toBe(true);
    expect(bastionPolicyCreateSchema.safeParse({}).success).toBe(false);
    expect(bastionPolicyCreateSchema.safeParse({ beacon_entry_id: ID, beacon_slug: 'a' }).success).toBe(false);
    expect(bastionPolicyCreateSchema.safeParse({ beacon_slug: 'not a slug!' }).success).toBe(false);
  });
});

describe('boolean query parameters (#215, #231)', () => {
  it("'false' parses as false, 'true' as true, anything else is refused", () => {
    expect(bastionDriftListQuerySchema.parse({ unacknowledged: 'false' }).unacknowledged).toBe(false);
    expect(bastionDriftListQuerySchema.parse({ unacknowledged: 'true' }).unacknowledged).toBe(true);
    expect(bastionDriftListQuerySchema.parse({}).unacknowledged).toBeUndefined();
    expect(bastionDriftListQuerySchema.safeParse({ unacknowledged: 'yes' }).success).toBe(false);
  });
  // The file-local "no coerce-boolean in bastion.ts" check is now repo-wide (#251):
  // scripts/check-no-coerce-boolean.mjs (lint.yml) and scripts/lib/no-coerce-boolean.test.mjs.
});

// The Bastion enums mirror CHECK constraints in the bastion migrations. This suite reads every
// migration file and fails when the two drift apart, so a new status value cannot land in one
// place only (fix the fact, not the place). It also ENUMERATES every CHECK IN-list on a
// bastion_* constraint, so a CHECK added by a later migration must be paired with a shared enum
// (CASES) or explicitly allowlisted; it cannot slip past unnoticed (#185).

const MIGRATIONS_DIR = join(__dirname, '../../../../infra/postgres/migrations');
const BASTION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_bastion_.*\.sql$/.test(f))
  .sort();
/** Comment lines stripped, so header prose naming a constraint cannot shadow its definition. */
const bastionSql = BASTION_FILES.map((f) =>
  readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n'),
).join('\n');

/**
 * The CHECK body of every bastion_* constraint. Files are read in migration order and a later
 * definition (a guarded drop/re-add, e.g. 0283 widening bastion_outbox_shape_check) replaces
 * the earlier one, so the map holds what the database enforces today.
 */
function collectChecks(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /ADD CONSTRAINT\s+(bastion_\w+)\s+CHECK\b/g;
  for (const m of bastionSql.matchAll(re)) {
    const start = m.index! + m[0].length;
    out.set(m[1]!, bastionSql.slice(start, bastionSql.indexOf(';', start)));
  }
  return out;
}
const CHECKS = collectChecks();

/** Every `<column> IN ('a', ...)` list inside a CHECK body, keyed by column. */
function inLists(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of body.matchAll(/\b(\w+)\s+IN\s*\(([^)]*)\)/g)) {
    const values = [...m[2]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
    if (values.length > 0) out.set(m[1]!, values);
  }
  return out;
}

/** The literal values a constraint allows for one column: `<column> IN ('a', 'b', ...)`. */
function checkValues(constraint: string, column: string): string[] {
  const body = CHECKS.get(constraint);
  if (body === undefined) throw new Error(`constraint ${constraint} not found in the bastion migrations`);
  const values = inLists(body).get(column);
  if (!values) throw new Error(`${constraint} has no "${column} IN (...)" list`);
  return values;
}

/**
 * CHECK IN-lists that deliberately have no shared enum. Each entry needs a reason; adding one is
 * a conscious decision, which is the point of the enumeration below.
 */
const NO_SHARED_ENUM: Record<string, string> = {};

const CASES: Array<[string, string, z.ZodEnum<[string, ...string[]]>]> = [
  ['bastion_frameworks_status_check', 'status', BastionFrameworkStatus],
  ['bastion_controls_status_check', 'status', BastionStoredStatus],
  ['bastion_controls_status_reason_check', 'status_reason', BastionStoredUnprovableReason],
  ['bastion_controls_coverage_kind_check', 'coverage_kind', BastionCoverageKind],
  ['bastion_controls_lifecycle_check', 'lifecycle', BastionControlLifecycle],
  ['bastion_control_requirements_applicability_check', 'applicability', BastionRequirementApplicability],
  ['bastion_control_requirements_source_check', 'source', BastionRequirementSource],
  ['bastion_org_settings_ranges_check', 'remediation_tasks', BastionRemediationTasks],
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

  it('finds the CHECK constraints (an empty parse would silently pass)', () => {
    expect(CHECKS.size).toBeGreaterThanOrEqual(37);
  });

  it('every CHECK in the bastion migrations is an ADD CONSTRAINT bastion_* the parser sees', () => {
    // An inline column CHECK or a differently named constraint would escape the enumeration.
    const allChecks = [...bastionSql.matchAll(/\bCHECK\s*\(/g)].length;
    const named = [...bastionSql.matchAll(/ADD CONSTRAINT\s+bastion_\w+\s+CHECK\s*\(/g)].length;
    expect(allChecks).toBe(named);
  });

  it('every CHECK IN-list on a bastion_* constraint is covered by CASES or allowlisted', () => {
    const covered = new Set(CASES.map(([c, col]) => `${c}.${col}`));
    const uncovered: string[] = [];
    for (const [constraint, body] of CHECKS) {
      for (const column of inLists(body).keys()) {
        const key = `${constraint}.${column}`;
        if (!covered.has(key) && !(key in NO_SHARED_ENUM)) uncovered.push(key);
      }
    }
    expect(uncovered, 'add a shared enum + CASES row, or a NO_SHARED_ENUM entry with a reason').toEqual([]);
  });

  it('has no stale NO_SHARED_ENUM entries', () => {
    for (const key of Object.keys(NO_SHARED_ENUM)) {
      const [constraint, column] = key.split('.') as [string, string];
      expect(() => checkValues(constraint, column), key).not.toThrow();
    }
  });
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

// #272: one owner for "string flag -> boolean" (boolQueryParam). An inline copy of its preprocess
// is the one-fact problem of #251 coming back inside Bastion.
describe('boolean flags use boolQueryParam, never an inline copy (#272)', () => {
  it('bastion.ts has no inline "v === \'true\'" preprocess outside the helper itself', () => {
    const lines = readFileSync(join(__dirname, 'bastion.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^export const boolQueryParam/.test(l));
    expect(lines.filter((l) => /v === 'true'/.test(l))).toEqual([]);
  });
});
