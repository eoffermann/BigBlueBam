// Mirrors bastion_evidence_feeds as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, date, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionEvidenceFeeds = pgTable(
  'bastion_evidence_feeds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    feed_key: varchar('feed_key', { length: 64 }).notNull(),
    label: varchar('label', { length: 256 }).notNull(),
    feed_kind: varchar('feed_kind', { length: 64 }),
    source_kind: varchar('source_kind', { length: 16 }).default('api_push').notNull(),
    bolt_source: varchar('bolt_source', { length: 32 }),
    bolt_event_type: varchar('bolt_event_type', { length: 128 }),
    cadence_days: integer('cadence_days').default(1).notNull(),
    daily_record_quota: integer('daily_record_quota').default(5000).notNull(),
    quota_day: date('quota_day'),
    records_on_quota_day: integer('records_on_quota_day').default(0).notNull(),
    bytes_total: bigint('bytes_total', { mode: 'number' }).default(0).notNull(),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    last_record_at: timestamp('last_record_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
