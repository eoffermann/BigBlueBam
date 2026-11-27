import { pgTable, uuid, varchar, text, numeric, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bearingGoals } from './bearing-goals.js';

export const bearingKeyResults = pgTable('bearing_key_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  goal_id: uuid('goal_id').notNull().references(() => bearingGoals.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  metric_type: varchar('metric_type', { length: 20 }).notNull().default('percentage'),
  target_value: numeric('target_value', { precision: 12, scale: 2 }).notNull().default('100'),
  current_value: numeric('current_value', { precision: 12, scale: 2 }).notNull().default('0'),
  start_value: numeric('start_value', { precision: 12, scale: 2 }).notNull().default('0'),
  unit: varchar('unit', { length: 50 }),
  direction: varchar('direction', { length: 10 }).notNull().default('increase'),
  progress_mode: varchar('progress_mode', { length: 20 }).notNull().default('manual'),
  linked_query: jsonb('linked_query'),
  progress: numeric('progress', { precision: 5, scale: 2 }).notNull().default('0'),
  // #160: the database FK (migration 0028) is ON DELETE NO ACTION.
  owner_id: uuid('owner_id').references(() => users.id),
  sort_order: integer('sort_order').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bearing_kr_goal').on(table.goal_id),
  index('idx_bearing_kr_owner').on(table.owner_id),
]);
