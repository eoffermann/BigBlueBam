import { pgTable, uuid, boolean, text, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * Per-action permissions (Wave A foundation, migrations 0144-0146; Wave B
 * adds backfill + telemetry in 0148/0149).
 *
 * Five tables compose the resolver. See docs/permissions-overhaul-plan.md
 * for the full design including the snapshot-and-detach group propagation
 * rule and the 7-step resolution algorithm.
 */

// ─────────────────────────────────────────────────────────────────────
// permissions: the static catalog of every <app>.<resource>.<verb> ID.
// ─────────────────────────────────────────────────────────────────────
//
// Generated from the action manifest by scripts/build-permission-codegen.mjs
// and seeded via 0145. CI guard scripts/check-permission-catalog.mjs
// prevents the manifest and migration from drifting.
export const permissions = pgTable(
  'permissions',
  {
    id: text('id').primaryKey(),
    app: text('app').notNull(),
    resource: text('resource').notNull(),
    verb: text('verb').notNull(),
    description: text('description'),
    is_destructive: boolean('is_destructive').default(false).notNull(),
    requires_confirmation: boolean('requires_confirmation').default(false).notNull(),
    is_read: boolean('is_read').default(false).notNull(),
    requires_superuser: boolean('requires_superuser').default(false).notNull(),
    introduced_at: timestamp('introduced_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (t) => ({
    appIdx: index('idx_permissions_app').on(t.app),
    resourceIdx: index('idx_permissions_resource').on(t.app, t.resource),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// permission_groups: built-in roles + operator-defined custom groups.
// ─────────────────────────────────────────────────────────────────────
//
// Five built-in rows are seeded by 0146 with fixed UUIDs and
// is_builtin=true. Operators create additional rows via the editor UI
// at scope_type in (global, org, project).
export const permissionGroups = pgTable(
  'permission_groups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    description: text('description'),
    scope_type: text('scope_type').notNull(),
    scope_id: uuid('scope_id'),
    is_builtin: boolean('is_builtin').default(false).notNull(),
    legacy_role: text('legacy_role'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    activeNameUnique: uniqueIndex('idx_permission_groups_unique_active_name').on(
      t.scope_type,
      sql`COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ).where(sql`deleted_at IS NULL`),
    scopeIdx: index('idx_permission_groups_scope').on(t.scope_type, t.scope_id),
    builtinLegacyRoleUnique: uniqueIndex('idx_permission_groups_builtin_legacy_role')
      .on(t.legacy_role)
      .where(sql`is_builtin = true AND deleted_at IS NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// permission_group_defaults: which permissions each group grants.
// ─────────────────────────────────────────────────────────────────────
export const permissionGroupDefaults = pgTable(
  'permission_group_defaults',
  {
    group_id: uuid('group_id')
      .notNull()
      .references(() => permissionGroups.id, { onDelete: 'cascade' }),
    permission_id: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    granted: boolean('granted').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.group_id, t.permission_id] }),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// permission_group_defaults_baseline: factory-defaults snapshot (Wave F.1.a,
// migration 0161). Mirrors permission_group_defaults with snapshot_at; read
// by POST /superuser/permissions/groups/:id/reset to restore the canonical
// defaults established by 0146/0156/0157/0158 without recomputing them.
// ─────────────────────────────────────────────────────────────────────
export const permissionGroupDefaultsBaseline = pgTable(
  'permission_group_defaults_baseline',
  {
    group_id: uuid('group_id')
      .notNull()
      .references(() => permissionGroups.id, { onDelete: 'cascade' }),
    permission_id: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    granted: boolean('granted').notNull(),
    snapshot_at: timestamp('snapshot_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.group_id, t.permission_id] }),
    groupIdx: index('idx_perm_group_defaults_baseline_group').on(t.group_id),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// account_permissions: explicit operator overrides + auto-snapshots.
// ─────────────────────────────────────────────────────────────────────
//
// Live-attached accounts have NO rows here; their permissions resolve
// through permission_group_defaults. The first explicit override at a
// scope triggers the BEFORE INSERT trigger account_permissions_detach
// which writes is_snapshot=true rows for every group default the user
// doesn't already have, then stamps detached_at on the membership.
export const accountPermissions = pgTable(
  'account_permissions',
  {
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope_type: text('scope_type').notNull(),
    scope_id: uuid('scope_id'),
    permission_id: text('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    granted: boolean('granted').notNull(),
    is_snapshot: boolean('is_snapshot').default(false).notNull(),
    set_by: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    set_at: timestamp('set_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    notes: text('notes'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.scope_type, t.scope_id, t.permission_id] }),
    userScopeIdx: index('idx_account_permissions_user_scope').on(
      t.user_id,
      t.scope_type,
      t.scope_id,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// account_group_memberships: which group each account is in per scope.
// ─────────────────────────────────────────────────────────────────────
//
// detached_at IS NULL → live (resolver reads group defaults).
// detached_at IS NOT NULL → snapshotted (resolver reads account_permissions).
// Re-attach via UI clears detached_at; rebase preserves overrides.
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
    detached_by: uuid('detached_by').references(() => users.id, { onDelete: 'set null' }),
    granted_by: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    granted_at: timestamp('granted_at', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.user_id, t.scope_type, t.scope_id] }),
    userIdx: index('idx_account_group_memberships_user').on(t.user_id),
    groupIdx: index('idx_account_group_memberships_group').on(t.group_id),
    scopeIdx: index('idx_account_group_memberships_scope').on(t.scope_type, t.scope_id),
    detachedIdx: index('idx_account_group_memberships_detached')
      .on(t.user_id, t.scope_type, t.scope_id)
      .where(sql`detached_at IS NOT NULL`),
  }),
);

// ─────────────────────────────────────────────────────────────────────
// permissions_divergence_log: Wave B telemetry table.
// ─────────────────────────────────────────────────────────────────────
//
// Truncated after Wave C flips enforcement. Indexed for the SuperUser
// dashboard's two main queries (paginate-by-time and group-by-permission).
export const permissionsDivergenceLog = pgTable(
  'permissions_divergence_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ts: timestamp('ts', { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
    request_id: text('request_id'),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    org_id: uuid('org_id'),
    permission_id: text('permission_id').notNull(),
    scope_type: text('scope_type').notNull(),
    scope_id: uuid('scope_id'),
    legacy_decision: text('legacy_decision').notNull(),
    resolved_decision: text('resolved_decision').notNull(),
    resolved_reason: text('resolved_reason').notNull(),
    route_method: text('route_method'),
    route_path: text('route_path'),
    is_divergent: boolean('is_divergent').notNull(),
  },
  (t) => ({
    tsIdx: index('idx_perm_div_ts').on(sql`ts DESC`).where(sql`is_divergent`),
    groupingIdx: index('idx_perm_div_grouping')
      .on(t.permission_id, t.route_path, t.route_method)
      .where(sql`is_divergent`),
    orgIdx: index('idx_perm_div_org').on(t.org_id, sql`ts DESC`),
  }),
);
