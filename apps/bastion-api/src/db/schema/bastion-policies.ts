// Mirrors bastion_policies as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionPolicies = pgTable(
  'bastion_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    beacon_entry_id: uuid('beacon_entry_id').notNull(),
    title_cache: varchar('title_cache', { length: 512 }),
    audience: jsonb('audience').default({"kind": "all"}).notNull(),
    cadence_days: integer('cadence_days').default(365).notNull(),
    owner_user_id: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 16 }).default('active').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
