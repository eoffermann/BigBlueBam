import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

/**
 * Canonical mirror of apps/api/src/db/schema/labels.ts.
 */
export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    color: varchar('color', { length: 7 }),
    description: text('description'),
    position: integer('position').default(0).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('labels_project_id_idx').on(table.project_id),
    uniqueIndex('labels_project_name_idx').on(table.project_id, table.name),
  ],
);
