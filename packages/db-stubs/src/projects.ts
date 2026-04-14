import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

/**
 * Canonical mirror of apps/api/src/db/schema/projects.ts.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 10 }),
    color: varchar('color', { length: 7 }),
    task_id_prefix: varchar('task_id_prefix', { length: 6 }).notNull(),
    task_id_sequence: integer('task_id_sequence').default(0).notNull(),
    default_sprint_duration_days: integer('default_sprint_duration_days').default(14).notNull(),
    settings: jsonb('settings').default({}).notNull(),
    is_archived: boolean('is_archived').default(false).notNull(),
    created_by: uuid('created_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('projects_org_id_idx').on(table.org_id),
    uniqueIndex('projects_org_slug_idx').on(table.org_id, table.slug),
  ],
);
