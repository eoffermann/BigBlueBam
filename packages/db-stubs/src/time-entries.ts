import { pgTable, uuid, integer, text, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { users } from './users.js';

/**
 * Canonical mirror of apps/api/src/db/schema/time-entries.ts.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    task_id: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    minutes: integer('minutes').notNull(),
    date: date('date').notNull(),
    description: text('description'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('time_entries_task_id_idx').on(table.task_id),
    index('time_entries_user_id_idx').on(table.user_id),
    index('time_entries_user_date_idx').on(table.user_id, table.date),
  ],
);
