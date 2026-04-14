import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

/**
 * Canonical mirror of apps/api/src/db/schema/phases.ts.
 */
export const phases = pgTable(
  'phases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    color: varchar('color', { length: 7 }),
    position: integer('position').default(0).notNull(),
    wip_limit: integer('wip_limit'),
    is_start: boolean('is_start').default(false).notNull(),
    is_terminal: boolean('is_terminal').default(false).notNull(),
    auto_state_on_enter: uuid('auto_state_on_enter'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('phases_project_id_idx').on(table.project_id),
    index('phases_project_position_idx').on(table.project_id, table.position),
  ],
);
