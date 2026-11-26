// Mirrors bastion_evaluation_runs as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { date, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionControls } from './bastion-controls.js';
import { organizations, users } from './bbb-refs.js';

export const bastionEvaluationRuns = pgTable(
  'bastion_evaluation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    trigger: varchar('trigger', { length: 16 }).notNull(),
    scope: varchar('scope', { length: 16 }).default('all').notNull(),
    control_id: uuid('control_id').references(() => bastionControls.id, { onDelete: 'set null' }),
    nightly_for_date: date('nightly_for_date'),
    as_of: timestamp('as_of', { withTimezone: true }).notNull(),
    status: varchar('status', { length: 16 }).default('queued').notNull(),
    partial_reason: varchar('partial_reason', { length: 48 }),
    resume_count: integer('resume_count').default(0).notNull(),
    controls_total: integer('controls_total').default(0).notNull(),
    controls_done: integer('controls_done').default(0).notNull(),
    pass_count: integer('pass_count').default(0).notNull(),
    fail_count: integer('fail_count').default(0).notNull(),
    unprovable_count: integer('unprovable_count').default(0).notNull(),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    started_by: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
