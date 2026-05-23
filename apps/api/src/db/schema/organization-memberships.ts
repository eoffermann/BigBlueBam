import { pgTable, uuid, boolean, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './organizations.js';
import { users } from './users.js';

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
    // Wave E.F: organization_memberships.role was dropped in migration 0159.
    // Per-org role is resolved from account_group_memberships →
    // permission_groups.legacy_role with scope_type='org' and scope_id=<org_id>.
    is_default: boolean('is_default').default(false).notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    // Optimistic-concurrency token for role/is_default updates (P1-25).
    // Every UPDATE that touches role or is_default MUST bump version.
    version: integer('version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('org_memberships_user_org_idx').on(table.user_id, table.org_id),
    index('org_memberships_user_id_idx').on(table.user_id),
    index('org_memberships_org_id_idx').on(table.org_id),
    index('org_memberships_user_default_idx').on(table.user_id, table.is_default),
    // At most one default membership per user.
    uniqueIndex('org_memberships_user_default_unique')
      .on(table.user_id)
      .where(sql`is_default = true`),
  ],
);
