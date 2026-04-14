import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { users } from './users.js';

/**
 * Canonical mirror of apps/api/src/db/schema/project-memberships.ts.
 */
export const projectMemberships = pgTable(
  'project_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 50 }).default('member').notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('project_memberships_unique_idx').on(table.project_id, table.user_id),
    index('project_memberships_user_id_idx').on(table.user_id),
  ],
);

/**
 * Legacy alias. Board-api historically imported this table as `projectMembers`.
 * Kept as a secondary export so the bbb-refs shim can re-export it under both
 * names without duplicating the pgTable declaration.
 */
export const projectMembers = projectMemberships;
