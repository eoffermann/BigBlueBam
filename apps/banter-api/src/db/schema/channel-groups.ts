import { pgTable, uuid, varchar, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, projects } from './bbb-refs.js';

export const banterChannelGroups = pgTable(
  'banter_channel_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    position: integer('position').notNull().default(0),
    is_collapsed_default: boolean('is_collapsed_default').notNull().default(false),
    // Slack import (migration 0163). Nullable FK to projects.id — the import
    // wizard sets this so a group is scoped to a project; standard Banter
    // groups stay NULL. ON DELETE SET NULL preserves chat history.
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('banter_channel_groups_project_id_idx').on(table.project_id),
  ],
);
