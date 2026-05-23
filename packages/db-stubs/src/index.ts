/**
 * Canonical Drizzle pgTable declarations for BigBlueBam core tables.
 *
 * These stubs exist so every non-Bam service (bolt-api, bond-api,
 * helpdesk-api, beacon-api, blast-api, ...) can reference core entities
 * (users, organizations, projects, tasks, ...) without duplicating the
 * declarations locally in each app. Each app previously had its own
 * `src/db/schema/bbb-refs.ts` copy that drifted over time.
 *
 * Contract: these tables expose the minimum columns any dependent service
 * actually reads. They MUST stay a subset of the Bam canonical schemas
 * in `apps/api/src/db/schema/`. If a dependent service needs a column not
 * listed here, add it here first (as nullable if the Bam schema allows
 * null, required otherwise), then ship the Bam schema change in the
 * same commit.
 *
 * Auth-critical columns: enriched to cover every column read by the
 * shared auth plugin pattern (apps/api/src/plugins/auth.ts) so that
 * dependent services can import these stubs directly instead of
 * maintaining local bbb-refs.ts copies.
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

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
    // Wave E.F: users.role was dropped in migration 0159. The per-org role
    // is resolved from account_group_memberships → permission_groups.legacy_role.
    timezone: varchar('timezone', { length: 50 }).default('UTC').notNull(),
    notification_prefs: jsonb('notification_prefs').default({}).notNull(),
    is_active: boolean('is_active').default(true).notNull(),
    is_superuser: boolean('is_superuser').default(false).notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('users_org_id_idx').on(table.org_id),
    index('users_email_idx').on(table.email),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    data: jsonb('data').default({}).notNull(),
    active_org_id: uuid('active_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.user_id),
    index('sessions_expires_at_idx').on(table.expires_at),
    index('sessions_active_org_id_idx').on(table.active_org_id),
  ],
);

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
    rotated_at: timestamp('rotated_at', { withTimezone: true }),
    rotation_grace_expires_at: timestamp('rotation_grace_expires_at', { withTimezone: true }),
    predecessor_id: uuid('predecessor_id').references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [
    index('api_keys_user_id_idx').on(table.user_id),
    index('api_keys_key_prefix_idx').on(table.key_prefix),
    index('idx_api_keys_org_id').on(table.org_id),
    index('idx_api_keys_rotation_grace').on(table.rotation_grace_expires_at),
    index('idx_api_keys_predecessor').on(table.predecessor_id),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    description: text('description'),
    is_archived: boolean('is_archived').default(false).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('projects_org_id_idx').on(table.org_id),
    uniqueIndex('projects_org_slug_idx').on(table.org_id, table.slug),
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
    // Per-org role is resolved from account_group_memberships → permission_groups.legacy_role.
    is_default: boolean('is_default').default(false).notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').default(1).notNull(),
  },
  (table) => [
    uniqueIndex('org_memberships_user_org_idx').on(table.user_id, table.org_id),
    index('org_memberships_user_id_idx').on(table.user_id),
    index('org_memberships_org_id_idx').on(table.org_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────
// Per-action permissions group membership stubs (Wave A foundation,
// migrations 0144-0146). After Wave E.F dropped users.role and
// organization_memberships.role, the per-org role for a user is resolved
// by joining accountGroupMemberships → permissionGroups.legacy_role with
// scope_type='org' and scope_id=<org_id>.
// ─────────────────────────────────────────────────────────────────────

export const permissionGroups = pgTable(
  'permission_groups',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    scope_type: text('scope_type').notNull(),
    scope_id: uuid('scope_id'),
    is_builtin: boolean('is_builtin').default(false).notNull(),
    legacy_role: text('legacy_role'),
    created_by: uuid('created_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_permission_groups_scope').on(t.scope_type, t.scope_id),
  ],
);

export const accountGroupMemberships = pgTable(
  'account_group_memberships',
  {
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    group_id: uuid('group_id')
      .notNull()
      .references(() => permissionGroups.id, { onDelete: 'restrict' }),
    scope_type: text('scope_type').notNull(),
    scope_id: uuid('scope_id'),
    detached_at: timestamp('detached_at', { withTimezone: true }),
    detached_by: uuid('detached_by'),
    granted_by: uuid('granted_by'),
    granted_at: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.scope_type, t.scope_id] }),
    index('idx_account_group_memberships_user').on(t.user_id),
    index('idx_account_group_memberships_group').on(t.group_id),
  ],
);

/**
 * Fixed UUIDs of the five built-in permission groups (seeded by migration
 * 0146). Used to translate a legacy role string into a group_id when
 * inserting account_group_memberships rows.
 */
export const BUILTIN_GROUP_IDS = {
  owner: '11111111-1111-4111-8111-111111111111',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333',
  viewer: '44444444-4444-4444-8444-444444444444',
  guest: '55555555-5555-4555-8555-555555555555',
} as const satisfies Record<string, string>;

export type BuiltinRole = keyof typeof BUILTIN_GROUP_IDS;

export function builtinGroupIdForRole(role: string): string {
  const id = (BUILTIN_GROUP_IDS as Record<string, string | undefined>)[role];
  if (!id) {
    throw new Error(`Unknown legacy role: ${role}`);
  }
  return id;
}

// ─────────────────────────────────────────────────────────────────────
// resolveUserOrgRoles — Wave E.F shared helper for satellite auth plugins.
// Returns Map<org_id, legacy_role> for a user. Drizzle isn't bound to a
// specific db client here, so this helper takes the db (or transaction)
// as its first arg.
// ─────────────────────────────────────────────────────────────────────

import { and, eq, sql as _sql } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveUserOrgRolesStub(dbInstance: any, userId: string): Promise<Map<string, string>> {
  const rows = await dbInstance
    .select({
      scope_id: accountGroupMemberships.scope_id,
      legacy_role: permissionGroups.legacy_role,
    })
    .from(accountGroupMemberships)
    .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(
      and(
        eq(accountGroupMemberships.user_id, userId),
        eq(accountGroupMemberships.scope_type, 'org'),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows as Array<{ scope_id: string | null; legacy_role: string | null }>) {
    if (r.scope_id && r.legacy_role) out.set(r.scope_id, r.legacy_role);
  }
  return out;
}

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  project_id: uuid('project_id').notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  state_id: uuid('state_id'),
  phase_id: uuid('phase_id'),
  sprint_id: uuid('sprint_id'),
  assignee_id: uuid('assignee_id'),
  priority: varchar('priority', { length: 20 }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }),
});

export const sprints = pgTable('sprints', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  project_id: uuid('project_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  status: varchar('status', { length: 50 }).notNull(),
  starts_at: timestamp('starts_at', { withTimezone: true }),
  ends_at: timestamp('ends_at', { withTimezone: true }),
});

export const phases = pgTable('phases', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  position: varchar('position', { length: 32 }).notNull(),
});

export const activityLog = pgTable('activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  actor_id: uuid('actor_id'),
  entity_type: varchar('entity_type', { length: 100 }).notNull(),
  entity_id: uuid('entity_id'),
  action: varchar('action', { length: 100 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
