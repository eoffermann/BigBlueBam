import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
  date,
  boolean,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects.js';
import { phases } from './phases.js';
import { taskStates } from './task-states.js';
import { sprints } from './sprints.js';
import { users } from './users.js';
import { organizations } from './organizations.js';

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Wave 1 §3.3 — RLS-support column. Added by migration
    // 0078_reconcile_bam_bearing_drift.sql (nullable) and backfilled +
    // tightened to NOT NULL by 0075_enable_rls_core_tables.sql. Declared
    // nullable here so the Drizzle type stays compatible with rows
    // written before the backfill, but every new insert should
    // populate it from the parent project's org_id.
    org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    human_id: varchar('human_id', { length: 50 }).notNull(),
    parent_task_id: uuid('parent_task_id'),
    title: varchar('title', { length: 500 }).notNull(),
    description: text('description'),
    description_plain: text('description_plain'),
    phase_id: uuid('phase_id')
      .references(() => phases.id, { onDelete: 'set null' }),
    state_id: uuid('state_id').references(() => taskStates.id),
    sprint_id: uuid('sprint_id').references(() => sprints.id),
    epic_id: uuid('epic_id'),
    assignee_id: uuid('assignee_id').references(() => users.id),
    reporter_id: uuid('reporter_id')
      .references(() => users.id, { onDelete: 'set null' }),
    priority: varchar('priority', { length: 20 }).default('medium').notNull(),
    story_points: integer('story_points'),
    time_estimate_minutes: integer('time_estimate_minutes'),
    time_logged_minutes: integer('time_logged_minutes').default(0).notNull(),
    start_date: date('start_date'),
    due_date: date('due_date'),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    position: doublePrecision('position').default(0).notNull(),
    labels: uuid('labels')
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    watchers: uuid('watchers')
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    is_blocked: boolean('is_blocked').default(false).notNull(),
    blocking_task_ids: uuid('blocking_task_ids')
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    blocked_by_task_ids: uuid('blocked_by_task_ids')
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    custom_fields: jsonb('custom_fields').default({}).notNull(),
    attachment_count: integer('attachment_count').default(0).notNull(),
    comment_count: integer('comment_count').default(0).notNull(),
    subtask_count: integer('subtask_count').default(0).notNull(),
    subtask_done_count: integer('subtask_done_count').default(0).notNull(),
    carry_forward_count: integer('carry_forward_count').default(0).notNull(),
    original_sprint_id: uuid('original_sprint_id'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('tasks_project_id_idx').on(table.project_id),
    index('tasks_human_id_idx').on(table.human_id),
    index('tasks_phase_id_idx').on(table.phase_id),
    index('tasks_state_id_idx').on(table.state_id),
    index('tasks_sprint_id_idx').on(table.sprint_id),
    index('tasks_assignee_id_idx').on(table.assignee_id),
    index('tasks_reporter_id_idx').on(table.reporter_id),
    index('tasks_epic_id_idx').on(table.epic_id),
    index('tasks_parent_task_id_idx').on(table.parent_task_id),
    index('tasks_priority_idx').on(table.priority),
    index('tasks_phase_position_idx').on(table.phase_id, table.position),
    index('tasks_project_sprint_idx').on(table.project_id, table.sprint_id),
    index('tasks_org_id_idx').on(table.org_id),
  ],
);
