import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { organizations } from './organizations.js';

/**
 * Canonical mirror of apps/api/src/db/schema/api-keys.ts.
 *
 * API keys are bound to a single org via the `org_id` column (migration
 * 0007_api_keys_org_scope.sql). The Bam auth plugin uses this as the
 * authoritative org context for Bearer-token requests so a key issued for
 * org A never leaks to org B.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    key_hash: text('key_hash').notNull(),
    key_prefix: varchar('key_prefix', { length: 12 }).notNull(),
    scope: varchar('scope', { length: 50 }).default('read').notNull(),
    project_ids: uuid('project_ids').array(),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    index('api_keys_user_id_idx').on(table.user_id),
    index('api_keys_key_prefix_idx').on(table.key_prefix),
    index('idx_api_keys_org_id').on(table.org_id),
  ],
);
