// Mirrors bastion_ledger_restores as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, date, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionLedgerRestores = pgTable(
  'bastion_ledger_restores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    detected_at: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
    db_head_seq: bigint('db_head_seq', { mode: 'number' }),
    bucket_seal_date: date('bucket_seal_date'),
    bucket_epoch: integer('bucket_epoch'),
    bucket_head_seq: bigint('bucket_head_seq', { mode: 'number' }),
    bucket_head_hash: varchar('bucket_head_hash', { length: 64 }),
    lost_from_seq: bigint('lost_from_seq', { mode: 'number' }),
    lost_to_seq: bigint('lost_to_seq', { mode: 'number' }),
    provisional_epoch: integer('provisional_epoch').notNull(),
    object_key: varchar('object_key', { length: 512 }),
    platform_restore_id: uuid('platform_restore_id'),
    status: varchar('status', { length: 16 }).notNull(),
    resolution: varchar('resolution', { length: 32 }),
    resolved_by: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
  },
);
