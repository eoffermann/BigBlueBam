// Mirrors bastion_ledger_entries as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, integer, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionLedgerEntries = pgTable(
  'bastion_ledger_entries',
  {
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    epoch: integer('epoch').default(1).notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    entry_kind: varchar('entry_kind', { length: 32 }).notNull(),
    entry_id: uuid('entry_id').notNull(),
    content_sha256: varchar('content_sha256', { length: 64 }),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    prev_entry_hash: varchar('prev_entry_hash', { length: 64 }).notNull(),
    entry_hash: varchar('entry_hash', { length: 64 }).notNull(),
    recorded_at: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.seq] })],
);
