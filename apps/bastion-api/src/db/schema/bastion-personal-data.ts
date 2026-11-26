// Mirrors bastion_personal_data as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionPersonalData = pgTable(
  'bastion_personal_data',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    holder_kind: varchar('holder_kind', { length: 24 }).notNull(),
    holder_id: uuid('holder_id').notNull(),
    data: jsonb('data').default({}).notNull(),
    data_hmac: varchar('data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    redacted_at: timestamp('redacted_at', { withTimezone: true }),
    redacted_by: uuid('redacted_by').references(() => users.id, { onDelete: 'set null' }),
    redaction_reason: text('redaction_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
