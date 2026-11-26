// Mirrors bastion_feed_records as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionEvidenceFeeds } from './bastion-evidence-feeds.js';
import { bastionFeedKeys } from './bastion-feed-keys.js';
import { organizations } from './bbb-refs.js';

export const bastionFeedRecords = pgTable(
  'bastion_feed_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    feed_id: uuid('feed_id').notNull().references(() => bastionEvidenceFeeds.id, { onDelete: 'restrict' }),
    feed_key_id: uuid('feed_key_id').references(() => bastionFeedKeys.id, { onDelete: 'restrict' }),
    idempotency_key: varchar('idempotency_key', { length: 256 }).notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    payload_sha256: varchar('payload_sha256', { length: 64 }).notNull(),
    personal_data_hmac: varchar('personal_data_hmac', { length: 64 }),
    pd_hmac_key_id: varchar('pd_hmac_key_id', { length: 64 }),
    ledger_seq: bigint('ledger_seq', { mode: 'number' }),
    received_at: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
