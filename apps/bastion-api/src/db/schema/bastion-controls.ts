// Mirrors bastion_controls as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { customType, date, integer, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './bbb-refs.js';

// Drizzle has no first-class tsvector column kind (mirrors braid-profiles.ts).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const bastionControls = pgTable(
  'bastion_controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_key: varchar('control_key', { length: 128 }).notNull(),
    title: varchar('title', { length: 512 }).notNull(),
    plain_summary: text('plain_summary'),
    category: varchar('category', { length: 64 }),
    risk_weight: smallint('risk_weight').default(3).notNull(),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    lifecycle: varchar('lifecycle', { length: 16 }).default('active').notNull(),
    status: varchar('status', { length: 16 }).default('unprovable').notNull(),
    status_reason: varchar('status_reason', { length: 48 }).default('not_yet_confirmed'),
    stale_reason: varchar('stale_reason', { length: 64 }),
    consecutive_error_nights: integer('consecutive_error_nights').default(0).notNull(),
    last_error_night: date('last_error_night'),
    coverage_kind: varchar('coverage_kind', { length: 16 }).default('none').notNull(),
    active_exception_count: integer('active_exception_count').default(0).notNull(),
    last_evaluated_at: timestamp('last_evaluated_at', { withTimezone: true }),
    status_changed_at: timestamp('status_changed_at', { withTimezone: true }),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(plain_summary, ''))`),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
