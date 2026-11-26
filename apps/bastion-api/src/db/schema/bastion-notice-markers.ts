// Mirrors bastion_notice_markers as created by migration 0287 (issue #243). Columns only: the
// (organization_id, marker_key) primary key and the RLS policy live in the migration, which is
// the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

export const bastionNoticeMarkers = pgTable('bastion_notice_markers', {
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  marker_key: varchar('marker_key', { length: 512 }).notNull(),
  first_sent_at: timestamp('first_sent_at', { withTimezone: true }).defaultNow().notNull(),
  last_sent_at: timestamp('last_sent_at', { withTimezone: true }).defaultNow().notNull(),
  sent_count: integer('sent_count').default(1).notNull(),
});
