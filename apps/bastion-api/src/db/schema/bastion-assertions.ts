// Mirrors bastion_assertions as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, jsonb, pgTable, text, timestamp, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { bastionCompileRuns } from './bastion-compile-runs.js';
import { bastionControls } from './bastion-controls.js';
import { bastionEvidenceFeeds } from './bastion-evidence-feeds.js';
import { organizations, users } from './bbb-refs.js';

export const bastionAssertions = pgTable(
  'bastion_assertions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    probe_key: varchar('probe_key', { length: 64 }),
    probe_version: integer('probe_version'),
    params: jsonb('params').default({}).notNull(),
    predicate: jsonb('predicate').default({}).notNull(),
    manual_evidence_spec: jsonb('manual_evidence_spec'),
    feed_id: uuid('feed_id').references(() => bastionEvidenceFeeds.id, { onDelete: 'restrict' }),
    plain_statement: text('plain_statement').notNull(),
    proposed_by: varchar('proposed_by', { length: 16 }).default('library').notNull(),
    compile_run_id: uuid('compile_run_id').references(() => bastionCompileRuns.id, { onDelete: 'set null' }),
    review_status: varchar('review_status', { length: 16 }).default('proposed').notNull(),
    // Self-FK (SET NULL), created by the migration.
    supersedes_id: uuid('supersedes_id').references((): AnyPgColumn => bastionAssertions.id, { onDelete: 'set null' }),
    confirmed_by: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmed_at: timestamp('confirmed_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
