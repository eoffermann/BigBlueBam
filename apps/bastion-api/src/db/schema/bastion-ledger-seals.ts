// Mirrors bastion_ledger_seals as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, date, integer, pgTable, primaryKey, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionLedgerSeals = pgTable(
  'bastion_ledger_seals',
  {
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    seal_date: date('seal_date').notNull(),
    epoch: integer('epoch').notNull(),
    head_seq: bigint('head_seq', { mode: 'number' }).notNull(),
    head_hash: varchar('head_hash', { length: 64 }).notNull(),
    signature: text('signature').notNull(),
    signing_key_id: varchar('signing_key_id', { length: 64 }).notNull(),
    object_written_at: timestamp('object_written_at', { withTimezone: true }),
    published_at: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.organization_id, table.seal_date] })],
);
