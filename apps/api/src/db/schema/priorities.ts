/**
 * Drizzle schema for the per-org priorities table (migration 0183).
 * tasks.priority stores the row's `value` slug so renaming display
 * names doesn't rewrite every task.
 */
import {
  pgTable, uuid, varchar, integer, boolean, timestamp, index, unique,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

export const priorities = pgTable(
  'priorities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    value: varchar('value', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 20 }).notNull(),
    icon: varchar('icon', { length: 50 }),
    position: integer('position').notNull(),
    is_default: boolean('is_default').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('priorities_org_id_value_key').on(table.org_id, table.value),
    index('idx_priorities_org_position').on(table.org_id, table.position),
  ],
);
