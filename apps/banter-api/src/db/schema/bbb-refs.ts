// NOTE: @bigbluebam/db-stubs provides minimal versions of these tables.
// This file retains the full column set needed by this service's auth
// plugin and domain queries. Once db-stubs is enriched with the full
// auth-necessary columns, these can be replaced with re-exports.
import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Minimal stubs for Bam tables referenced by Banter
// These mirror the existing Bam schema but are defined here so
// banter-api can reference them without importing from @bigbluebam/api.

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  logo_url: text('logo_url'),
  plan: varchar('plan', { length: 50 }).default('free').notNull(),
  settings: jsonb('settings').default({}).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Minimal stub of the Bam projects table. Banter doesn't need the full
// column set — the Slack import wizard only links its channel groups and
// channels to a project_id (migrations 0163/0164/0165). Full schema lives
// in apps/api/src/db/schema/projects.ts.
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).unique().notNull(),
    display_name: varchar('display_name', { length: 100 }).notNull(),
    avatar_url: text('avatar_url'),
    password_hash: text('password_hash'),
    // Wave E.F: users.role was dropped in migration 0159. Per-org role is
    // resolved from account_group_memberships → permission_groups.legacy_role.
    timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
    notification_prefs: jsonb('notification_prefs').default({}).notNull(),
    is_active: boolean('is_active').default(true).notNull(),
    is_superuser: boolean('is_superuser').default(false).notNull(),
    // §1 Wave 5 banter subs - mirror users.kind so the banter-api side
    // can gate subscription writes on actor type (agent/service only).
    // Enum is defined in apps/api migration 0127; we render it as varchar
    // here to avoid coupling to a Drizzle pgEnum declared elsewhere.
    kind: varchar('kind', { length: 20 }).default('human').notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('users_org_id_idx').on(table.org_id),
    index('users_email_idx').on(table.email),
  ],
);

// §1 Wave 5 banter subs - minimal stub for agent_policies so the banter
// subscription service can check the §15 policy (enabled + channel_subscriptions)
// without duplicating the full schema. Full schema lives at
// apps/api/src/db/schema/agent-policies.ts.
export const agentPolicies = pgTable('agent_policies', {
  agent_user_id: uuid('agent_user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  org_id: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(true).notNull(),
  channel_subscriptions: uuid('channel_subscriptions').array().notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    data: jsonb('data').default({}).notNull(),
    // Session-level active org. Set by Bam's /auth/switch-org and
    // /superuser/context/switch. Mirrors the column already present in
    // the live DB (see apps/api/src/db/schema/sessions.ts) so Banter can
    // honor cross-app org switches. No migration needed — the column
    // already exists; this declaration closes a drift gap.
    active_org_id: uuid('active_org_id'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.user_id),
    index('sessions_expires_at_idx').on(table.expires_at),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
  ],
);

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
    // Per-org role is resolved from account_group_memberships → permission_groups.
    is_default: boolean('is_default').default(false).notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('org_memberships_user_org_idx').on(table.user_id, table.org_id),
    index('org_memberships_user_id_idx').on(table.user_id),
    index('org_memberships_org_id_idx').on(table.org_id),
  ],
);

// Wave E.F: per-action permissions group memberships, used to resolve role
// in the auth plugin and elsewhere. Full schema lives in apps/api.
export const permissionGroups = pgTable('permission_groups', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  scope_type: text('scope_type').notNull(),
  scope_id: uuid('scope_id'),
  is_builtin: boolean('is_builtin').default(false).notNull(),
  legacy_role: text('legacy_role'),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const accountGroupMemberships = pgTable('account_group_memberships', {
  user_id: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  group_id: uuid('group_id')
    .notNull()
    .references(() => permissionGroups.id, { onDelete: 'restrict' }),
  scope_type: text('scope_type').notNull(),
  scope_id: uuid('scope_id'),
  detached_at: timestamp('detached_at', { withTimezone: true }),
  granted_at: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
});

// SuperUser impersonation sessions. Canonical definition lives in
// @bigbluebam/db-stubs (subset of apps/api/src/db/schema/impersonation-sessions.ts).
// Re-exported here so this service's auth plugin can verify an active,
// unexpired impersonation session before honoring X-Impersonate-User.
export { impersonationSessions } from '@bigbluebam/db-stubs';
