// Mirrors bastion_manual_evidence as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, date, integer, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionManualEvidence = pgTable(
  'bastion_manual_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    description: text('description'),
    source_system: varchar('source_system', { length: 128 }),
    bin_asset_id: uuid('bin_asset_id'),
    bin_asset_version_id: uuid('bin_asset_version_id'),
    content_sha256: varchar('content_sha256', { length: 64 }),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    content_type: varchar('content_type', { length: 255 }),
    scan_label: varchar('scan_label', { length: 16 }),
    owner_user_id: uuid('owner_user_id'),
    uploaded_by: uuid('uploaded_by').notNull(),
    produced_on: date('produced_on'),
    period_start: date('period_start'),
    period_end: date('period_end'),
    valid_until: timestamp('valid_until', { withTimezone: true }),
    sensitivity: varchar('sensitivity', { length: 16 }).default('standard').notNull(),
    uploader_statement_at: timestamp('uploader_statement_at', { withTimezone: true }),
    status: varchar('status', { length: 16 }).default('pending_scan').notNull(),
    blocked_reason: varchar('blocked_reason', { length: 48 }),
    attempts: integer('attempts').default(0).notNull(),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
    // Self-FK (RESTRICT) declared in the migration.
    superseded_by_id: uuid('superseded_by_id'),
    withdrawn_reason: varchar('withdrawn_reason', { length: 48 }),
    withdrawn_by: uuid('withdrawn_by'),
    withdrawn_at: timestamp('withdrawn_at', { withTimezone: true }),
    redacted_at: timestamp('redacted_at', { withTimezone: true }),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    ledger_seq: bigint('ledger_seq', { mode: 'number' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
