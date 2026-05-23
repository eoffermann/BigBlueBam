/**
 * Per-org role resolver (Wave E.F).
 *
 * After migration 0159 dropped users.role and organization_memberships.role,
 * the canonical source of truth for a user's role within an org is the
 * account_group_memberships table joined to permission_groups.legacy_role
 * with scope_type='org' and scope_id=<org_id>.
 *
 * This module is the single place that performs the join. Callers should
 * NEVER read role from users or organization_memberships (those columns no
 * longer exist) and should NEVER write role to organization_memberships
 * (the column no longer exists). To change a user's role within an org,
 * update or insert a row in account_group_memberships pointing at the
 * appropriate built-in group (BUILTIN_GROUP_IDS).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db as defaultDb } from '../db/index.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';

// Fixed UUIDs of the five built-in permission groups (seeded by migration
// 0146). Used to translate a legacy role string into a group_id when
// inserting account_group_memberships rows.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = typeof defaultDb | PgTransaction<any, any, any>;

/**
 * Returns the legacy_role for one (user, org) pair, or null if the user
 * has no org-scope group membership for that org. Detached snapshots still
 * return the group's legacy_role — they remain pinned to whichever group
 * they were attached to at detach time.
 */
export async function resolveUserOrgRole(
  userId: string,
  orgId: string,
  dbInstance: DbLike = defaultDb,
): Promise<string | null> {
  const [row] = await dbInstance
    .select({ legacy_role: permissionGroups.legacy_role })
    .from(accountGroupMemberships)
    .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(
      and(
        eq(accountGroupMemberships.user_id, userId),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, orgId),
      ),
    )
    .limit(1);
  return row?.legacy_role ?? null;
}

/**
 * Returns a map of org_id → legacy_role for every org a user is grouped
 * into. Used by the auth hook to build OrgMembership[].role in one query.
 */
export async function resolveUserOrgRoles(
  userId: string,
  dbInstance: DbLike = defaultDb,
): Promise<Map<string, string>> {
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
  for (const r of rows) {
    if (r.scope_id && r.legacy_role) out.set(r.scope_id, r.legacy_role);
  }
  return out;
}

/**
 * Returns a map of user_id → legacy_role for every user grouped into the
 * given org. Used by listOrgMembers and similar bulk reads.
 */
export async function resolveOrgUserRoles(
  orgId: string,
  userIds: string[] | null,
  dbInstance: DbLike = defaultDb,
): Promise<Map<string, string>> {
  if (userIds && userIds.length === 0) return new Map();
  const whereConds = [
    eq(accountGroupMemberships.scope_type, 'org'),
    eq(accountGroupMemberships.scope_id, orgId),
  ];
  if (userIds) whereConds.push(inArray(accountGroupMemberships.user_id, userIds));
  const rows = await dbInstance
    .select({
      user_id: accountGroupMemberships.user_id,
      legacy_role: permissionGroups.legacy_role,
    })
    .from(accountGroupMemberships)
    .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(and(...whereConds));
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.legacy_role) out.set(r.user_id, r.legacy_role);
  }
  return out;
}

/**
 * Upsert the user's org-scope group membership to the built-in group for
 * the given legacy role. If the user already has a row at this scope, the
 * group_id is updated; otherwise a fresh row is inserted. Idempotent.
 *
 * Wave E.F: this replaces the dropped `organization_memberships.role`
 * column as the write path for role changes.
 */
export async function setUserOrgRole(
  userId: string,
  orgId: string,
  role: string,
  opts: { grantedBy?: string | null } = {},
  dbInstance: DbLike = defaultDb,
): Promise<void> {
  const groupId = builtinGroupIdForRole(role);
  await dbInstance
    .insert(accountGroupMemberships)
    .values({
      user_id: userId,
      group_id: groupId,
      scope_type: 'org',
      scope_id: orgId,
      granted_by: opts.grantedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        accountGroupMemberships.user_id,
        accountGroupMemberships.scope_type,
        accountGroupMemberships.scope_id,
      ],
      set: {
        group_id: groupId,
        granted_at: sql`now()`,
        granted_by: opts.grantedBy ?? null,
        // Re-attach: clearing detached_at puts the row back into "live"
        // mode so the resolver reads new group defaults instead of the
        // stale snapshot.
        detached_at: null,
        detached_by: null,
      },
    });
}

/**
 * Remove the user's org-scope group membership. Used by removeMember /
 * de-provisioning paths. Idempotent — silently succeeds when no row
 * exists.
 */
export async function clearUserOrgRole(
  userId: string,
  orgId: string,
  dbInstance: DbLike = defaultDb,
): Promise<void> {
  await dbInstance
    .delete(accountGroupMemberships)
    .where(
      and(
        eq(accountGroupMemberships.user_id, userId),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, orgId),
      ),
    );
}

/**
 * Build a Drizzle subquery that exposes (user_id, org_id, role) for every
 * org-scope group membership. Use this in SELECT statements that need to
 * read role alongside other org-scoped columns:
 *
 *   const omRole = orgRoleSubquery();
 *   db.select({ ..., role: omRole.role })
 *     .from(organizationMemberships)
 *     .leftJoin(omRole, and(
 *       eq(omRole.user_id, organizationMemberships.user_id),
 *       eq(omRole.org_id, organizationMemberships.org_id),
 *     ));
 *
 * Returns a SQL fragment, since Drizzle's typed subquery API is awkward
 * for this pattern. Callers can simply use raw SQL via sql.raw() if they
 * prefer.
 */
export function orgRoleSqlFragment() {
  // Raw SQL helper for places that need role as a derived column.
  return sql<string | null>`(
    SELECT pg.legacy_role
    FROM account_group_memberships agm
    JOIN permission_groups pg ON pg.id = agm.group_id
    WHERE agm.user_id = ${sql.identifier('user_id')}
      AND agm.scope_type = 'org'
      AND agm.scope_id = ${sql.identifier('org_id')}
    LIMIT 1
  )`;
}
