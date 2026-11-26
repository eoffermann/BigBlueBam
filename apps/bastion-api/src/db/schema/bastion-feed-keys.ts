// Mirrors bastion_feed_keys as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionEvidenceFeeds } from './bastion-evidence-feeds.js';
import { organizations, users } from './bbb-refs.js';

export const bastionFeedKeys = pgTable(
  'bastion_feed_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    feed_id: uuid('feed_id').notNull().references(() => bastionEvidenceFeeds.id, { onDelete: 'cascade' }),
    key_id: varchar('key_id', { length: 64 }).notNull(),
    secret_hmac: varchar('secret_hmac', { length: 128 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 64 }),
    last4: varchar('last4', { length: 8 }),
    label: varchar('label', { length: 128 }),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    grace_expires_at: timestamp('grace_expires_at', { withTimezone: true }),
    // Self-FK (SET NULL) declared in the migration.
    predecessor_id: uuid('predecessor_id'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
  },
);
