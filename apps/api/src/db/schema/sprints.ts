import { pgTable, uuid, varchar, text, integer, date, timestamp, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { organizations } from './organizations.js';

export const sprints = pgTable(
  'sprints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Wave 1 §3.3 — RLS-support column. Added by migration
    // 0075_enable_rls_core_tables.sql (backfilled from projects.org_id
    // and set NOT NULL when the backfill covers every row). The column
    // is declared nullable here because on databases that predate the
    // migration the enforcement pass may not have run yet; the Bam API
    // still writes to sprints via project_id, and the Wave 2 handler
    // conversion will start populating org_id explicitly.
    org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    goal: text('goal'),
    start_date: date('start_date'),
    end_date: date('end_date'),
    status: varchar('status', { length: 50 }).default('planned').notNull(),
    velocity: integer('velocity'),
    notes: text('notes'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    closed_at: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    index('sprints_project_id_idx').on(table.project_id),
    index('sprints_project_status_idx').on(table.project_id, table.status),
    index('sprints_org_id_idx').on(table.org_id),
  ],
);
