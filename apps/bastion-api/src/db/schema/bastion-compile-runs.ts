// Mirrors bastion_compile_runs as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionFrameworks } from './bastion-frameworks.js';
import { organizations, users } from './bbb-refs.js';

export const bastionCompileRuns = pgTable(
  'bastion_compile_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    framework_id: uuid('framework_id').notNull().references(() => bastionFrameworks.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).default('queued').notNull(),
    controls_total: integer('controls_total').default(0).notNull(),
    controls_done: integer('controls_done').default(0).notNull(),
    assertions_proposed: integer('assertions_proposed').default(0).notNull(),
    assertions_dropped: integer('assertions_dropped').default(0).notNull(),
    drop_reasons: jsonb('drop_reasons').default({}).notNull(),
    llm_calls_used: integer('llm_calls_used').default(0).notNull(),
    used_fallback: boolean('used_fallback').default(false).notNull(),
    resume_count: integer('resume_count').default(0).notNull(),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    slice_token: uuid('slice_token'),
    error: text('error'),
    started_by: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
