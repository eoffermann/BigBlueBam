// Mirrors bastion_control_requirements as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionControls } from './bastion-controls.js';
import { bastionFrameworks } from './bastion-frameworks.js';
import { organizations, users } from './bbb-refs.js';

export const bastionControlRequirements = pgTable(
  'bastion_control_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').notNull().references(() => bastionControls.id, { onDelete: 'cascade' }),
    framework_id: uuid('framework_id').notNull().references(() => bastionFrameworks.id, { onDelete: 'cascade' }),
    ref_code: varchar('ref_code', { length: 64 }).notNull(),
    requirement_title: varchar('requirement_title', { length: 512 }).notNull(),
    applicability: varchar('applicability', { length: 16 }).default('applicable').notNull(),
    not_applicable_reason: text('not_applicable_reason'),
    decided_by: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    source: varchar('source', { length: 16 }).default('crosswalk').notNull(),
    removed_at: timestamp('removed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
