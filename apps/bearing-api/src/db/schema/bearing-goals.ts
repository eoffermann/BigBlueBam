import { pgTable, uuid, varchar, text, boolean, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';
import { users } from './bbb-refs.js';
import { projects } from './bbb-refs.js';
import { bearingPeriods } from './bearing-periods.js';

export const bearingGoals = pgTable('bearing_goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  period_id: uuid('period_id').notNull().references(() => bearingPeriods.id, { onDelete: 'cascade' }),
  scope: varchar('scope', { length: 20 }).notNull().default('organization'),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  team_name: varchar('team_name', { length: 100 }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }),
  color: varchar('color', { length: 20 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  status_override: boolean('status_override').notNull().default(false),
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),
  // #160: the database FK (migration 0028) is ON DELETE NO ACTION, and owner_id is NOT NULL
  // there, so 'set null' was never possible.
  owner_id: uuid('owner_id').references(() => users.id).notNull(),
  created_by: uuid('created_by').notNull().references(() => users.id),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bearing_goals_org').on(table.organization_id),
  index('idx_bearing_goals_period').on(table.period_id),
  index('idx_bearing_goals_owner').on(table.owner_id),
  index('idx_bearing_goals_project').on(table.project_id),
  index('idx_bearing_goals_status').on(table.status),
]);
