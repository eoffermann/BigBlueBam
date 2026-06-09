/**
 * Bam task table stubs — used by blueprint-api for cross-app reads
 * (e.g. "generate Blueprint from Bam project tasks"). The canonical
 * schemas live in apps/api/src/db/schema/; we only declare the columns
 * blueprint-api actually queries, mirroring the pattern in
 * @bigbluebam/db-stubs.
 *
 * NEVER write to these tables from blueprint-api — task mutations must
 * go through Bam's HTTP API so the task service can run its
 * activity-log + Bolt-event + WebSocket-broadcast side-effects.
 */
import { pgTable, uuid, varchar, text, timestamp, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

export const tasksStub = pgTable('tasks', {
  id: uuid('id').primaryKey(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  parent_task_id: uuid('parent_task_id').references((): AnyPgColumn => tasksStub.id),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  description_plain: text('description_plain'),
  human_id: varchar('human_id', { length: 64 }),
  phase_id: uuid('phase_id'),
  state_id: uuid('state_id'),
  sprint_id: uuid('sprint_id'),
  assignee_id: uuid('assignee_id').references(() => users.id),
  reporter_id: uuid('reporter_id').references(() => users.id),
  priority: varchar('priority', { length: 16 }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const taskParentLinksStub = pgTable('task_parent_links', {
  task_id: uuid('task_id').notNull(),
  parent_task_id: uuid('parent_task_id').notNull(),
});

// Re-export the projects+org refs so the service can do the org-scope check.
export { projects, organizations };
