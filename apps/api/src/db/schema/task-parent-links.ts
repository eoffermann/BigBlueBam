import { pgTable, uuid, timestamp, primaryKey, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { tasks } from './tasks.js';
import { users } from './users.js';

/**
 * Many-to-many parent/child link between tasks (B3 Frndo Launch).
 *
 * A single subtask can have multiple parents because more than one parent
 * task may legitimately depend on the same shared piece of work. Cycles
 * (a → b, b → a) are blocked at the application layer via a bounded DFS
 * cycle check; self-loops (a → a) are blocked at the DB layer via a CHECK
 * constraint.
 *
 * The legacy tasks.parent_task_id self-FK column is kept as the "primary
 * parent" hint that drives the existing subtask_count / subtask_done_count
 * denormalization. Reads that need ALL parents/children walk this join
 * table; reads that only need the single primary parent can keep using
 * tasks.parent_task_id for cheap O(1) access.
 */
export const taskParentLinks = pgTable(
  'task_parent_links',
  {
    task_id: uuid('task_id')
      .notNull()
      .references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
    parent_task_id: uuid('parent_task_id')
      .notNull()
      .references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    created_by: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.parent_task_id] }),
    index('task_parent_links_parent_idx').on(table.parent_task_id),
    index('task_parent_links_task_idx').on(table.task_id),
  ],
);
