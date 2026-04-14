import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Canonical mirror of apps/api/src/db/schema/organization-memberships.ts.
 */
export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).default('member').notNull(),
    is_default: boolean('is_default').default(false).notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    // Optimistic-concurrency token for role/is_default updates (P1-25).
    version: integer('version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('org_memberships_user_org_idx').on(table.user_id, table.org_id),
    index('org_memberships_user_id_idx').on(table.user_id),
    index('org_memberships_org_id_idx').on(table.org_id),
    index('org_memberships_user_default_idx').on(table.user_id, table.is_default),
    uniqueIndex('org_memberships_user_default_unique')
      .on(table.user_id)
      .where(sql`is_default = true`),
    check(
      'org_memberships_role_check',
      sql`role IN ('owner', 'admin', 'member', 'viewer', 'guest')`,
    ),
  ],
);
