// Mirrors bastion_questionnaires as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { boolean, date, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionQuestionnaires = pgTable(
  'bastion_questionnaires',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 512 }).notNull(),
    requester_label: varchar('requester_label', { length: 256 }),
    bond_deal_id: uuid('bond_deal_id'),
    bond_company_id: uuid('bond_company_id'),
    source_bin_asset_id: uuid('source_bin_asset_id'),
    source_bin_asset_version_id: uuid('source_bin_asset_version_id'),
    source_sha256: varchar('source_sha256', { length: 64 }),
    format: varchar('format', { length: 8 }).notNull(),
    column_map: jsonb('column_map').default({}).notNull(),
    status: varchar('status', { length: 16 }).default('uploaded').notNull(),
    injection_suspected: boolean('injection_suspected').default(false).notNull(),
    row_count: integer('row_count').default(0).notNull(),
    rows_done: integer('rows_done').default(0).notNull(),
    low_count: integer('low_count').default(0).notNull(),
    medium_count: integer('medium_count').default(0).notNull(),
    high_count: integer('high_count').default(0).notNull(),
    resume_count: integer('resume_count').default(0).notNull(),
    due_date: date('due_date'),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    claimed_by: varchar('claimed_by', { length: 128 }),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    slice_token: uuid('slice_token'),
    approved_by: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
