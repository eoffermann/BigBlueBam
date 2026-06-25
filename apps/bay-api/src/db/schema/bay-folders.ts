import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';

// Bay review folders. A hierarchical organizing layer for Bay review assets,
// mirroring Bin's folder tree: org-scoped, optionally project-scoped, with a
// self parent reference for nesting.
export const bayFolders = pgTable(
  'bay_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    parent_id: uuid('parent_id').references((): AnyPgColumn => bayFolders.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bay_folders_org').on(table.org_id),
    index('idx_bay_folders_parent').on(table.parent_id),
    index('idx_bay_folders_project').on(table.project_id),
  ],
);
