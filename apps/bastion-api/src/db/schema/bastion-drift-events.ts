// Mirrors bastion_drift_events as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionControls } from './bastion-controls.js';
import { bastionEvaluationRuns } from './bastion-evaluation-runs.js';
import { bastionEvidenceSnapshots } from './bastion-evidence-snapshots.js';
import { bastionExceptions } from './bastion-exceptions.js';
import { organizations, users } from './bbb-refs.js';

export const bastionDriftEvents = pgTable(
  'bastion_drift_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'cascade' }),
    evaluation_run_id: uuid('evaluation_run_id').references(() => bastionEvaluationRuns.id, { onDelete: 'set null' }),
    from_status: varchar('from_status', { length: 32 }).notNull(),
    to_status: varchar('to_status', { length: 32 }).notNull(),
    reason: varchar('reason', { length: 64 }).notNull(),
    snapshot_id: uuid('snapshot_id').references(() => bastionEvidenceSnapshots.id, { onDelete: 'set null' }),
    bam_task_id: uuid('bam_task_id'),
    // varchar(32) since 0285: 'project_unavailable' (#229) does not fit in 16.
    task_status: varchar('task_status', { length: 32 }).default('pending').notNull(),
    proposal_id: uuid('proposal_id'),
    acknowledged_by: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }),
    // 0283 (#188): set only for exception-expiry drift (evaluation_run_id NULL); unique per
    // (organization_id, exception_id, control_id), so a retried expiry job cannot double-write.
    exception_id: uuid('exception_id').references(() => bastionExceptions.id, { onDelete: 'restrict' }),
    detected_at: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
