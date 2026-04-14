import { pgTable, uuid, varchar, text, timestamp, numeric, index } from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bearingGoals } from './bearing-goals.js';

export const bearingUpdates = pgTable('bearing_updates', {
  id: uuid('id').primaryKey().defaultRandom(),
  goal_id: uuid('goal_id').notNull().references(() => bearingGoals.id, { onDelete: 'cascade' }),
  author_id: uuid('author_id').notNull().references(() => users.id),
  // status is added to the DB by migration 0078 (nullable) to match this
  // declaration. It captures the author's chosen status tag for the update
  // ('on_track' / 'at_risk' / 'behind' / 'achieved' / 'missed'). Migration
  // 0078 keeps the column nullable because existing rows pre-date it.
  status: varchar('status', { length: 20 }),
  body: text('body'),
  // status_at_time and progress_at_time were introduced by migration 0028 as
  // NOT NULL and were never reflected in Drizzle. Declared here so db-check
  // stops flagging them as unknown-in-Drizzle. They are filled by the
  // insert-update code path in apps/bearing-api; the insert site is the
  // authoritative source of values for these columns.
  status_at_time: varchar('status_at_time', { length: 20 }).notNull(),
  progress_at_time: numeric('progress_at_time', { precision: 5, scale: 4 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bearing_updates_goal').on(table.goal_id),
  index('idx_bearing_updates_author').on(table.author_id),
]);
