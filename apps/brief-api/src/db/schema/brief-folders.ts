import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users, organizations, projects } from './bbb-refs.js';

export const briefFolders = pgTable(
  'brief_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    parent_id: uuid('parent_id').references((): AnyPgColumn => briefFolders.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 300 }).notNull(),
    sort_order: integer('sort_order').default(0).notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_brief_folders_org_project').on(table.org_id, table.project_id),
    index('idx_brief_folders_parent_id').on(table.parent_id),
    index('idx_brief_folders_slug').on(table.slug),
  ],
);
