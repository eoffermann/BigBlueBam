// Mirrors bastion_evidence_snapshots as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAssertions } from './bastion-assertions.js';
import { bastionControls } from './bastion-controls.js';
import { bastionEvaluationRuns } from './bastion-evaluation-runs.js';
import { organizations } from './bbb-refs.js';

export const bastionEvidenceSnapshots = pgTable(
  'bastion_evidence_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    evaluation_run_id: uuid('evaluation_run_id').notNull().references(() => bastionEvaluationRuns.id, { onDelete: 'restrict' }),
    assertion_id: uuid('assertion_id').notNull().references(() => bastionAssertions.id, { onDelete: 'restrict' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'restrict' }),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    unprovable_reason: varchar('unprovable_reason', { length: 48 }),
    probe_key: varchar('probe_key', { length: 64 }),
    probe_version: integer('probe_version'),
    params: jsonb('params').default({}).notNull(),
    query_fingerprint: varchar('query_fingerprint', { length: 64 }),
    population_checked: jsonb('population_checked'),
    population_unlisted: jsonb('population_unlisted'),
    window_start: timestamp('window_start', { withTimezone: true }),
    window_end: timestamp('window_end', { withTimezone: true }),
    summary: jsonb('summary').default({}).notNull(),
    cited_refs: jsonb('cited_refs').default([]).notNull(),
    overflow_count: integer('overflow_count').default(0).notNull(),
    manual_evidence_ids: uuid('manual_evidence_ids').array().default([]).notNull(),
    exception_ids: uuid('exception_ids').array().default([]).notNull(),
    feed_record_count: integer('feed_record_count').default(0).notNull(),
    replica_lag_ms: integer('replica_lag_ms'),
    content_sha256: varchar('content_sha256', { length: 64 }).notNull(),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    ledger_seq: bigint('ledger_seq', { mode: 'number' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
