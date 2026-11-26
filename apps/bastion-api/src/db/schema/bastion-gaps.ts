// Mirrors bastion_gaps as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { numeric, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAssertions } from './bastion-assertions.js';
import { bastionControls } from './bastion-controls.js';
import { organizations, users } from './bbb-refs.js';

export const bastionGaps = pgTable(
  'bastion_gaps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'cascade' }),
    assertion_id: uuid('assertion_id').references(() => bastionAssertions.id, { onDelete: 'cascade' }),
    gap_kind: varchar('gap_kind', { length: 24 }).notNull(),
    risk_score: numeric('risk_score', { precision: 8, scale: 4 }).default('0').notNull(),
    fix_template: varchar('fix_template', { length: 24 }),
    fix_cost: smallint('fix_cost'),
    status: varchar('status', { length: 16 }).default('open').notNull(),
    dismissed_reason: text('dismissed_reason'),
    dismissed_by: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
    computed_at: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
