import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

// Bin DAM folders (Bin master §9.1). Folders are a hierarchical organizing
// layer for assets; org-scoped, optionally project-scoped, with a self
// parent reference for nesting.
export const binFolders = pgTable(
  'bin_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    parent_id: uuid('parent_id').references((): AnyPgColumn => binFolders.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bin_folders_org').on(table.org_id),
    index('idx_bin_folders_parent').on(table.parent_id),
    index('idx_bin_folders_project').on(table.project_id),
  ],
);
