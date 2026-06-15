import { pgTable, uuid, varchar, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

/**
 * Shape of the `settings` JSONB column on the organizations table.
 *
 * The `permissions` object holds configurable toggles that org admins/owners can set
 * to control what regular members can do within their organization. Keys correspond
 * to `DEFAULT_ORG_PERMISSIONS` in `services/org-permissions.ts`. Missing keys fall
 * back to the defaults defined there.
 *
 * Example:
 * {
 *   "permissions": {
 *     "members_can_create_projects": true,
 *     "members_can_delete_own_projects": false,
 *     "members_can_create_channels": true,
 *     "members_can_create_private_channels": true,
 *     "members_can_create_group_dms": true,
 *     "max_file_upload_mb": 25,
 *     "members_can_invite_members": false,
 *     "members_can_create_api_keys": true,
 *     "allowed_api_key_scopes": ["read", "read_write"]
 *   },
 *   "branding": { ... },
 *   "features": { ... }
 * }
 */
export interface OrganizationSettings {
  permissions?: {
    members_can_create_projects?: boolean;
    members_can_delete_own_projects?: boolean;
    members_can_create_channels?: boolean;
    members_can_create_private_channels?: boolean;
    members_can_create_group_dms?: boolean;
    max_file_upload_mb?: number;
    members_can_invite_members?: boolean;
    members_can_create_api_keys?: boolean;
    allowed_api_key_scopes?: string[];
  };
  [key: string]: unknown;
}

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  logo_url: text('logo_url'),
  plan: varchar('plan', { length: 50 }).default('free').notNull(),
  settings: jsonb('settings').$type<OrganizationSettings>().default({}).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // Soft-delete marker (migration 0191). platform_delete_org sets these instead
  // of a hard DELETE (which the NO ACTION/RESTRICT FK web rejects). Reads filter
  // `deleted_at IS NULL`; the row + authored content survive for audit.
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  deleted_by: uuid('deleted_by'),
});
