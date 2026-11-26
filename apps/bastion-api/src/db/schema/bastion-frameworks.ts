// Mirrors bastion_frameworks as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { date, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionFrameworks = pgTable(
  'bastion_frameworks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    template_key: varchar('template_key', { length: 64 }).notNull(),
    template_version: varchar('template_version', { length: 32 }).notNull(),
    name: varchar('name', { length: 256 }).notNull(),
    status: varchar('status', { length: 16 }).default('compiling').notNull(),
    audit_target_date: date('audit_target_date'),
    period_start: date('period_start'),
    period_end: date('period_end'),
    adopted_at: timestamp('adopted_at', { withTimezone: true }),
    adopted_by: uuid('adopted_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
