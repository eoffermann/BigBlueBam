/**
 * Minimal reference definitions for BigBlueBam tables that the helpdesk schema
 * needs to reference via foreign keys. These mirror the real Bam tables but only
 * include the columns needed for helpdesk operations.
 */
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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  display_name: varchar('display_name', { length: 100 }).notNull(),
  is_active: boolean('is_active').default(true).notNull(),
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  logo_url: text('logo_url'),
  plan: varchar('plan', { length: 50 }).default('free').notNull(),
  settings: jsonb('settings').default({}).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  task_id_prefix: varchar('task_id_prefix', { length: 6 }),
  task_id_sequence: integer('task_id_sequence').default(0).notNull(),
  is_archived: boolean('is_archived').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const phases = pgTable('phases', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  position: integer('position').default(0).notNull(),
  is_start: boolean('is_start').default(false).notNull(),
  is_terminal: boolean('is_terminal').default(false).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  human_id: varchar('human_id', { length: 50 }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  description_plain: text('description_plain'),
  phase_id: uuid('phase_id').references(() => phases.id, { onDelete: 'set null' }),
  priority: varchar('priority', { length: 20 }).default('medium').notNull(),
  assignee_id: uuid('assignee_id'),
  reporter_id: uuid('reporter_id'),
  labels: uuid('labels')
    .array()
    .default(sql`'{}'::uuid[]`)
    .notNull(),
  custom_fields: jsonb('custom_fields').default({}).notNull(),
  position: doublePrecision('position').default(0).notNull(),
  start_date: date('start_date'),
  due_date: date('due_date'),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  story_points: integer('story_points'),
  time_estimate_minutes: integer('time_estimate_minutes'),
  time_logged_minutes: integer('time_logged_minutes').default(0).notNull(),
  is_blocked: boolean('is_blocked').default(false).notNull(),
  blocking_task_ids: uuid('blocking_task_ids')
    .array()
    .default(sql`'{}'::uuid[]`)
    .notNull(),
  blocked_by_task_ids: uuid('blocked_by_task_ids')
    .array()
    .default(sql`'{}'::uuid[]`)
    .notNull(),
  attachment_count: integer('attachment_count').default(0).notNull(),
  comment_count: integer('comment_count').default(0).notNull(),
  subtask_count: integer('subtask_count').default(0).notNull(),
  subtask_done_count: integer('subtask_done_count').default(0).notNull(),
  carry_forward_count: integer('carry_forward_count').default(0).notNull(),
  original_sprint_id: uuid('original_sprint_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const labels = pgTable('labels', {
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
});
