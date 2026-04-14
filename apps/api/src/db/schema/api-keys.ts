import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { organizations } from './organizations.js';

// P2-8 (FIXED): API keys are now bound to a single org via the `org_id`
// column (migration 0007_api_keys_org_scope.sql). The auth plugin uses
// `api_keys.org_id` as the authoritative org context for Bearer-token
// requests, so a key issued for org A never leaks to org B even if the
// owning user joins additional orgs via organization_memberships.
// X-Org-Id header is ignored for non-SuperUser API key auth.
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
    // Wave 1 §3.14 — API key rotation. Populated by the rotate endpoint;
    // see migration 0077_api_key_rotation.sql.
    rotated_at: timestamp('rotated_at', { withTimezone: true }),
    rotation_grace_expires_at: timestamp('rotation_grace_expires_at', { withTimezone: true }),
    predecessor_id: uuid('predecessor_id'),
  },
  (table) => [
    index('api_keys_user_id_idx').on(table.user_id),
    index('api_keys_key_prefix_idx').on(table.key_prefix),
    index('idx_api_keys_org_id').on(table.org_id),
  ],
);
