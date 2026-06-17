import { eq, and, sql, inArray, desc, lt, or, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type Redis from 'ioredis';
import { db } from '../db/index.js';
import { cacheGetOrSet, cacheInvalidate, CACHE_KEYS } from '../lib/cache.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { sessions } from '../db/schema/sessions.js';
import { projects } from '../db/schema/projects.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { activityLog } from '../db/schema/activity-log.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { resolveUserOrgRole, setUserOrgRole } from './role-resolver.js';
import { generatePassword } from './password-generator.service.js';

export async function getOrganization(orgId: string) {
  const [org] = await db
    .select()
    .from(organizations)
    // Soft-deleted orgs (migration 0191) are invisible to every read path.
    .where(and(eq(organizations.id, orgId), isNull(organizations.deleted_at)))
    .limit(1);

  return org ?? null;
}

// In-process fallback cache for callers that don't have a Redis client
// handy (e.g. CLI entry points). The Redis path below is preferred and is
// used by every authenticated request route via fastify.redis.
type CachedOrg = Awaited<ReturnType<typeof getOrganization>>;
const orgCache = new Map<string, { data: NonNullable<CachedOrg>; expires: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds
const ORG_REDIS_TTL_SECONDS = 60;

export async function getOrganizationCached(
  orgIdOrRedis: string | Redis,
  maybeOrgId?: string,
) {
  // Overload: `getOrganizationCached(orgId)` keeps the in-process path;
  // `getOrganizationCached(redis, orgId)` uses the shared Redis cache.
  if (typeof orgIdOrRedis === 'string') {
    const orgId = orgIdOrRedis;
    const cached = orgCache.get(orgId);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }
    const org = await getOrganization(orgId);
    if (org) {
      orgCache.set(orgId, { data: org, expires: Date.now() + CACHE_TTL_MS });
    }
    return org;
  }

  const redis = orgIdOrRedis;
  const orgId = maybeOrgId!;
  return cacheGetOrSet(redis, CACHE_KEYS.orgSettings(orgId), ORG_REDIS_TTL_SECONDS, () =>
    getOrganization(orgId),
  );
}

export function invalidateOrgCache(orgId: string, redis?: Redis) {
  orgCache.delete(orgId);
  if (redis) {
    void cacheInvalidate(redis, CACHE_KEYS.orgSettings(orgId));
  }
}

export async function updateOrganization(
  orgId: string,
  data: { name?: string; logo_url?: string | null; settings?: Record<string, unknown> },
) {
  const updateValues: Record<string, unknown> = { updated_at: new Date() };
  if (data.name !== undefined) updateValues.name = data.name;
  if (data.logo_url !== undefined) updateValues.logo_url = data.logo_url;
  if (data.settings !== undefined) updateValues.settings = data.settings;

  const [org] = await db
    .update(organizations)
    .set(updateValues)
    .where(eq(organizations.id, orgId))
    .returning();

  invalidateOrgCache(orgId);

  return org ?? null;
}

export async function listOrgMembers(orgId: string) {
  // Source of truth is organization_memberships joined with the
  // account_group_memberships → permission_groups path (Wave E.F). Each
  // member's per-org role is resolved from the org-scope group row.
  const result = await db
    .select({
      id: users.id,
      email: users.email,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      role: permissionGroups.legacy_role,
      is_active: users.is_active,
      created_at: users.created_at,
      last_seen_at: users.last_seen_at,
      version: organizationMemberships.version,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.user_id, users.id))
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(eq(organizationMemberships.org_id, orgId))
    .orderBy(users.display_name);

  return result.map((r) => ({ ...r, role: r.role ?? 'member' }));
}

/** Counts members of an org who are also currently active (is_active=true). */
export async function getOrgMemberCounts(orgId: string): Promise<{
  active_owner_count: number;
  member_count: number;
}> {
  // Wave E.F: owner status is the group's legacy_role joined via
  // account_group_memberships, not organization_memberships.role.
  const [row] = await db
    .select({
      active_owner_count: sql<number>`COUNT(*) FILTER (WHERE ${permissionGroups.legacy_role} = 'owner' AND ${users.is_active} = true)::int`,
      member_count: sql<number>`COUNT(*) FILTER (WHERE ${users.is_active} = true)::int`,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.user_id, users.id))
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(eq(organizationMemberships.org_id, orgId));

  return {
    active_owner_count: Number(row?.active_owner_count ?? 0),
    member_count: Number(row?.member_count ?? 0),
  };
}

/** Custom error raised when inviteMember detects the invitee is already a
 *  member of the target org. The route handler translates this to 409. */
export class AlreadyMemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyMemberError';
  }
}

export async function inviteMember(
  orgId: string,
  email: string,
  role: string,
  displayName?: string,
  projectIds?: string[],
): Promise<{ user: { id: string; email: string; display_name: string; avatar_url: string | null; role: string; is_active: boolean; created_at: Date; password_hash: string | null }; was_existing: boolean; projects_added: string[]; projects_skipped: string[] }> {
  // Look up an existing user by email first — they may already exist from
  // a different org's invite. The users.email UNIQUE constraint makes email
  // the global identity; multi-org belonging is expressed via
  // organization_memberships rows.
  const normalizedEmail = email.toLowerCase().trim();

  // Project assignments (B3 Frndo Launch). Filter out duplicates, validate
  // every project belongs to the org we're inviting into. Cross-org IDs
  // surface a CrossOrgProjectError to the route, which maps to a 400.
  const uniqueProjectIds = projectIds ? Array.from(new Set(projectIds)) : [];
  if (uniqueProjectIds.length > 0) {
    const bad = await findCrossOrgProjects(orgId, uniqueProjectIds);
    if (bad.length > 0) throw new CrossOrgProjectError(bad);
  }
  const [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existingUser) {
    // Already a member of THIS org? Reject — nothing to do.
    const [existingMembership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, existingUser.id),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .limit(1);
    if (existingMembership) {
      throw new AlreadyMemberError('User is already a member of this organization');
    }
    // Add them as a member of this org. is_default stays false — their
    // existing default org is preserved so their next login lands where
    // they expect.
    const existingProjectResult = await db.transaction(async (tx) => {
      await tx.insert(organizationMemberships).values({
        user_id: existingUser.id,
        org_id: orgId,
        is_default: false,
      });
      // Wave E.F: role is stored in account_group_memberships, not on the
      // membership row.
      await setUserOrgRole(existingUser.id, orgId, role, {}, tx);
      return await insertProjectMemberships(tx, existingUser.id, uniqueProjectIds);
    });
    const safeExisting = {
      id: existingUser.id,
      email: existingUser.email,
      display_name: existingUser.display_name,
      avatar_url: existingUser.avatar_url,
      role,
      is_active: existingUser.is_active,
      created_at: existingUser.created_at,
      // Surface password_hash status so the route can decide whether to
      // mint an onboarding token (only for users who have no password yet,
      // i.e. brand-new users joining their second org from the invite UI
      // before they ever set a password).
      password_hash: existingUser.password_hash,
    };
    return {
      user: safeExisting,
      was_existing: true,
      projects_added: existingProjectResult.added,
      projects_skipped: existingProjectResult.skipped,
    };
  }

  // Brand-new user — create the user row + their first membership. This
  // org becomes their default. users.org_id is filled in as the legacy
  // single-org fallback; per-org role lives in account_group_memberships.
  return await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        org_id: orgId,
        email: normalizedEmail,
        display_name: displayName ?? normalizedEmail.split('@')[0]!,
      })
      .returning();

    await tx.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: orgId,
      is_default: true,
    });

    // Wave E.F: role lives in account_group_memberships now.
    await setUserOrgRole(user!.id, orgId, role, {}, tx);

    const projectResult = await insertProjectMemberships(tx, user!.id, uniqueProjectIds);

    const safeUser = {
      id: user!.id,
      email: user!.email,
      display_name: user!.display_name,
      avatar_url: user!.avatar_url,
      role,
      is_active: user!.is_active,
      created_at: user!.created_at,
      password_hash: user!.password_hash,
    };
    return {
      user: safeUser,
      was_existing: false,
      projects_added: projectResult.added,
      projects_skipped: projectResult.skipped,
    };
  });
}

/**
 * Idempotent project-membership insert used by inviteMember. Cross-org
 * validation is performed by the caller (it needs to happen before we
 * start the txn so a bad input doesn't leave a half-created user behind).
 * Returns the per-project added/skipped split so the route can echo it
 * in the invite response.
 */
async function insertProjectMemberships(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  projectIds: string[],
  defaultRole: 'admin' | 'member' | 'viewer' = 'member',
): Promise<{ added: string[]; skipped: string[] }> {
  if (projectIds.length === 0) return { added: [], skipped: [] };

  const existing = await tx
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        inArray(projectMemberships.project_id, projectIds),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.project_id));

  const toInsert = projectIds.filter((id) => !existingSet.has(id));
  if (toInsert.length > 0) {
    await tx
      .insert(projectMemberships)
      .values(
        toInsert.map((project_id) => ({
          project_id,
          user_id: userId,
          role: defaultRole,
        })),
      )
      .onConflictDoNothing({
        target: [projectMemberships.project_id, projectMemberships.user_id],
      });
  }
  return {
    added: toInsert,
    skipped: projectIds.filter((id) => existingSet.has(id)),
  };
}

const ROLE_HIERARCHY = ['guest', 'viewer', 'member', 'admin', 'owner'] as const;

/** Raised when the caller's rank isn't strictly above the target's rank. */
export class InsufficientRankError extends Error {
  constructor(message = 'You cannot act on a user at or above your own role') {
    super(message);
    this.name = 'InsufficientRankError';
  }
}

/** Raised when an optimistic-concurrency update found the row, but the
 *  row's version didn't match the caller's `expected_version`. The caller
 *  should re-read the membership and retry (P1-25). `currentVersion` is
 *  surfaced so the API layer can echo it back in the 409 response. */
export class VersionConflictError extends Error {
  public readonly code = 'VERSION_CONFLICT' as const;
  constructor(public readonly currentVersion: number) {
    super('Membership was updated by someone else');
    this.name = 'VersionConflictError';
  }
}

/**
 * Rank check: caller's level must be strictly ABOVE target's level, AND
 * caller must be at least admin. SuperUsers bypass the check entirely.
 */
export function checkRankAbove(
  callerRole: string,
  targetRole: string,
  callerIsSuperuser: boolean,
): { allowed: boolean; reason?: string } {
  if (callerIsSuperuser) return { allowed: true };

  const callerLevel = ROLE_HIERARCHY.indexOf(callerRole as (typeof ROLE_HIERARCHY)[number]);
  const targetLevel = ROLE_HIERARCHY.indexOf(targetRole as (typeof ROLE_HIERARCHY)[number]);

  if (callerLevel < 0 || targetLevel < 0) {
    return { allowed: false, reason: 'Unknown role' };
  }
  if (callerLevel < ROLE_HIERARCHY.indexOf('admin')) {
    return { allowed: false, reason: 'Caller must be admin or owner' };
  }
  if (callerLevel <= targetLevel) {
    return {
      allowed: false,
      reason: 'You cannot act on a user at or above your own role',
    };
  }
  return { allowed: true };
}

/** Fetches a user's membership role for a given org, or null if not a member.
 *  Wave E.F: role is resolved from account_group_memberships → permission_groups. */
export async function getMembershipRole(orgId: string, userId: string): Promise<string | null> {
  // Confirm membership first; users without a membership row return null
  // even if a stale group row still exists.
  const [m] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    )
    .limit(1);
  if (!m) return null;
  return await resolveUserOrgRole(userId, orgId);
}

/** Validates that every project in `projectIds` belongs to `orgId`. Returns
 *  the list of project IDs that do NOT belong (empty = all valid). */
async function findCrossOrgProjects(orgId: string, projectIds: string[]): Promise<string[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({ id: projects.id, org_id: projects.org_id })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const byId = new Map(rows.map((r) => [r.id, r.org_id]));
  const bad: string[] = [];
  for (const pid of projectIds) {
    const row = byId.get(pid);
    if (!row || row !== orgId) bad.push(pid);
  }
  return bad;
}

export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: string,
  opts: { callerRole: string; callerIsSuperuser: boolean; expectedVersion?: number },
): Promise<(typeof users.$inferSelect & { membership_version: number; role: string }) | null> {
  // Wave E.F: role is no longer a column on organization_memberships —
  // it's resolved from account_group_memberships → permission_groups.
  // We still lock the membership row and bump its version so the UI's
  // optimistic-concurrency gate keeps working unchanged.
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM organization_memberships WHERE user_id = ${userId} AND org_id = ${orgId} FOR UPDATE`,
    );

    // Load target's current membership version + resolved role for the
    // rank check and for the optimistic-concurrency gate.
    const [existing] = await tx
      .select({ version: organizationMemberships.version })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .limit(1);

    if (!existing) return null;

    const existingRole = (await resolveUserOrgRole(userId, orgId, tx)) ?? 'member';

    const rank = checkRankAbove(opts.callerRole, existingRole, opts.callerIsSuperuser);
    if (!rank.allowed) {
      throw new InsufficientRankError(rank.reason);
    }

    if (
      opts.expectedVersion !== undefined &&
      existing.version !== opts.expectedVersion
    ) {
      throw new VersionConflictError(existing.version);
    }

    // Bump the membership version so any opted-in caller observes the drift.
    const [membership] = await tx
      .update(organizationMemberships)
      .set({ version: sql`${organizationMemberships.version} + 1` })
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .returning({ version: organizationMemberships.version });

    if (!membership) return null;

    // Write the new role into account_group_memberships.
    await setUserOrgRole(userId, orgId, role, {}, tx);

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;
    return { ...user, role, membership_version: membership.version };
  });
}

/** Raised when the caller tries to reset a password for a user whose role
 *  is above their own, or when they try to reset their own password through
 *  this admin endpoint. */
export class PasswordResetForbiddenError extends Error {
  constructor(
    message: string,
    public readonly code: 'CANNOT_RESET_SELF' | 'INSUFFICIENT_PERMISSIONS' | 'TARGET_NOT_FOUND',
  ) {
    super(message);
    this.name = 'PasswordResetForbiddenError';
  }
}

/**
 * Resets the password of another user. The caller must be either:
 *  - A SuperUser (may reset anyone, anywhere), or
 *  - An owner/admin of `orgId` whose role rank is STRICTLY above the
 *    target's membership role in that org (peers cannot reset each other).
 *
 * Caller may not reset their own password here — they should go through
 * the profile/settings flow instead.
 *
 * On success, returns the target user + the raw password (visible exactly
 * once to the admin for sharing). All of the target's active sessions are
 * invalidated so any stolen cookie becomes unusable after the reset.
 */
export async function resetMemberPassword(opts: {
  orgId: string;
  targetUserId: string;
  callerUserId: string;
  callerIsSuperuser: boolean;
  callerRole: string;
  newPassword: string | null;
}): Promise<{ user: typeof users.$inferSelect; password: string }> {
  const { orgId, targetUserId, callerUserId, callerIsSuperuser, callerRole, newPassword } = opts;

  if (targetUserId === callerUserId) {
    throw new PasswordResetForbiddenError(
      'Use profile settings to change your own password',
      'CANNOT_RESET_SELF',
    );
  }

  // Fetch target user. SuperUsers may reset anyone (regardless of membership
  // in the current org); everyone else must target a member of the caller's
  // active org, and we read that membership's role for the rank comparison.
  const [targetUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!targetUser) {
    throw new PasswordResetForbiddenError('Target user not found', 'TARGET_NOT_FOUND');
  }

  if (!callerIsSuperuser) {
    const targetRole = await getMembershipRole(orgId, targetUserId);

    if (!targetRole) {
      // Don't leak existence — target is not a member of YOUR org.
      throw new PasswordResetForbiddenError('Target user not found', 'TARGET_NOT_FOUND');
    }

    const rank = checkRankAbove(callerRole, targetRole, callerIsSuperuser);
    if (!rank.allowed) {
      throw new PasswordResetForbiddenError(
        rank.reason ?? 'You cannot reset the password of a user at or above your own role',
        'INSUFFICIENT_PERMISSIONS',
      );
    }
  }

  const rawPassword = newPassword ?? (await generatePassword());
  const passwordHash = await argon2.hash(rawPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where(eq(users.id, targetUserId));
    // Invalidate every active session for the target so a leaked cookie
    // can't outlive the reset.
    await tx.delete(sessions).where(eq(sessions.user_id, targetUserId));
  });

  return { user: targetUser, password: rawPassword };
}

export async function removeMember(
  orgId: string,
  userId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
) {
  const targetRole = await getMembershipRole(orgId, userId);
  if (!targetRole) return null;

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  // Only remove the MEMBERSHIP row — the user identity lives globally and
  // may still be a member of other orgs. Deleting the user row outright
  // would have cascade-deleted their sessions, API keys, and every other
  // org's membership of the same user.
  const [deleted] = await db
    .delete(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    )
    .returning();

  return deleted ?? null;
}

/** Detailed view of a single member in the current org, including the
 *  user's project memberships scoped to THIS org. Returns null if the
 *  target is not a member of this org. */
export async function getOrgMemberDetail(orgId: string, userId: string) {
  // Wave E.F: role resolves via account_group_memberships → permission_groups.
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      timezone: users.timezone,
      is_active: users.is_active,
      disabled_at: users.disabled_at,
      disabled_by: users.disabled_by,
      created_at: users.created_at,
      last_seen_at: users.last_seen_at,
      role: permissionGroups.legacy_role,
      joined_at: organizationMemberships.joined_at,
      is_default_org: organizationMemberships.is_default,
      version: organizationMemberships.version,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(organizationMemberships.user_id, users.id))
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Load disabled_by info (only the small identity subset) if set.
  let disabledBy: { id: string; email: string; display_name: string } | null = null;
  if (row.disabled_by) {
    const [dbRow] = await db
      .select({
        id: users.id,
        email: users.email,
        display_name: users.display_name,
      })
      .from(users)
      .where(eq(users.id, row.disabled_by))
      .limit(1);
    disabledBy = dbRow ?? null;
  }

  // Project memberships in THIS org.
  const userProjects = await db
    .select({
      project_id: projects.id,
      name: projects.name,
      role: projectMemberships.role,
      joined_at: projectMemberships.joined_at,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.project_id, projects.id))
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        eq(projects.org_id, orgId),
      ),
    )
    .orderBy(projects.name);

  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    timezone: row.timezone,
    role: row.role ?? 'member',
    is_active: row.is_active,
    disabled_at: row.disabled_at,
    disabled_by: disabledBy,
    joined_at: row.joined_at,
    is_default_org: row.is_default_org,
    version: row.version,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    projects: userProjects,
  };
}

/** Updates display_name / timezone on the target user row. Rank check is
 *  expected to be enforced by the caller. Returns the updated user or null
 *  if target isn't a member of this org. */
export async function updateMemberProfile(
  orgId: string,
  userId: string,
  data: { display_name?: string; timezone?: string },
  opts: { callerRole: string; callerIsSuperuser: boolean },
) {
  const targetRole = await getMembershipRole(orgId, userId);
  if (!targetRole) return null;

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  const updateValues: Record<string, unknown> = { updated_at: new Date() };
  if (data.display_name !== undefined) updateValues.display_name = data.display_name;
  if (data.timezone !== undefined) updateValues.timezone = data.timezone;

  const [updated] = await db
    .update(users)
    .set(updateValues)
    .where(eq(users.id, userId))
    .returning();

  return updated ?? null;
}

/** Toggle is_active for the target user. When disabling, all of the
 *  target's sessions are invalidated. Returns status + whether the org
 *  now has zero active owners (for a UI banner). */
export async function setMemberActive(
  orgId: string,
  userId: string,
  isActive: boolean,
  opts: {
    callerUserId: string;
    callerRole: string;
    callerIsSuperuser: boolean;
    expectedVersion?: number;
  },
): Promise<{
  user_id: string;
  is_active: boolean;
  disabled_at: Date | null;
  last_owner_remaining: boolean;
  membership_version: number;
} | null> {
  if (userId === opts.callerUserId) {
    throw new InsufficientRankError('You cannot change your own active status');
  }

  const targetRole = await getMembershipRole(orgId, userId);
  if (!targetRole) return null;

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  const result = await db.transaction(async (tx) => {
    // Optimistic-concurrency gate on the membership row. Even though the
    // active/disabled columns live on `users`, we version by membership so
    // a single UI ("People in THIS org") sees all member-targeted edits
    // through one token.
    const [existing] = await tx
      .select({ version: organizationMemberships.version })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .limit(1);

    if (!existing) return null;

    if (
      opts.expectedVersion !== undefined &&
      existing.version !== opts.expectedVersion
    ) {
      throw new VersionConflictError(existing.version);
    }

    const [bumped] = await tx
      .update(organizationMemberships)
      .set({ version: sql`${organizationMemberships.version} + 1` })
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .returning({ version: organizationMemberships.version });

    if (isActive) {
      const [u] = await tx
        .update(users)
        .set({ is_active: true, disabled_at: null, disabled_by: null, updated_at: new Date() })
        .where(eq(users.id, userId))
        .returning();
      return u ? { user: u, version: bumped!.version } : null;
    }

    const [u] = await tx
      .update(users)
      .set({
        is_active: false,
        disabled_at: new Date(),
        disabled_by: opts.callerUserId,
        updated_at: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    // Kill all sessions for the disabled user.
    await tx.delete(sessions).where(eq(sessions.user_id, userId));
    return u ? { user: u, version: bumped!.version } : null;
  });

  if (!result) return null;

  const counts = await getOrgMemberCounts(orgId);

  return {
    user_id: result.user.id,
    is_active: result.user.is_active,
    disabled_at: result.user.disabled_at,
    last_owner_remaining: counts.active_owner_count === 0,
    membership_version: result.version,
  };
}

/** Error raised by transferOwnership for bad preconditions. */
export class TransferOwnershipError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CALLER_NOT_OWNER'
      | 'TARGET_NOT_MEMBER'
      | 'CANNOT_TRANSFER_TO_SELF',
  ) {
    super(message);
    this.name = 'TransferOwnershipError';
  }
}

/** Atomically transfer ownership from caller to target within an org.
 *  Caller must currently be an owner of the org (or a SuperUser).
 *  Target must be a current member of the org. */
export async function transferOwnership(opts: {
  orgId: string;
  callerUserId: string;
  targetUserId: string;
  callerIsSuperuser: boolean;
}): Promise<{ previous_owner_id: string; new_owner_id: string; org_id: string }> {
  const { orgId, callerUserId, targetUserId, callerIsSuperuser } = opts;

  if (callerUserId === targetUserId) {
    throw new TransferOwnershipError(
      'You cannot transfer ownership to yourself',
      'CANNOT_TRANSFER_TO_SELF',
    );
  }

  return await db.transaction(async (tx) => {
    // Lock both membership rows to serialize concurrent transfers.
    await tx.execute(
      sql`SELECT 1 FROM organization_memberships WHERE org_id = ${orgId} AND user_id IN (${callerUserId}, ${targetUserId}) FOR UPDATE`,
    );

    // Wave E.F: caller role is resolved from account_group_memberships now.
    const callerRole = await resolveUserOrgRole(callerUserId, orgId, tx);
    const callerHasMembership = callerRole !== null;

    if (!callerIsSuperuser && callerRole !== 'owner') {
      throw new TransferOwnershipError(
        'Only an owner may transfer ownership',
        'CALLER_NOT_OWNER',
      );
    }

    // Confirm target is a member of this org.
    const [targetMembership] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.user_id, targetUserId),
          eq(organizationMemberships.org_id, orgId),
        ),
      )
      .limit(1);

    if (!targetMembership) {
      throw new TransferOwnershipError(
        'Target user is not a member of this organization',
        'TARGET_NOT_MEMBER',
      );
    }

    // Demote caller to admin (only if caller had a membership — SuperUsers
    // may not be members of this org). Bump membership `version` (P1-25)
    // so any UI holding a stale copy of either row is forced to re-read.
    if (callerHasMembership) {
      await setUserOrgRole(callerUserId, orgId, 'admin', { grantedBy: callerUserId }, tx);
      await tx
        .update(organizationMemberships)
        .set({ version: sql`${organizationMemberships.version} + 1` })
        .where(
          and(
            eq(organizationMemberships.user_id, callerUserId),
            eq(organizationMemberships.org_id, orgId),
          ),
        );
    }

    // Promote target to owner.
    await setUserOrgRole(targetUserId, orgId, 'owner', { grantedBy: callerUserId }, tx);
    await tx
      .update(organizationMemberships)
      .set({ version: sql`${organizationMemberships.version} + 1` })
      .where(
        and(
          eq(organizationMemberships.user_id, targetUserId),
          eq(organizationMemberships.org_id, orgId),
        ),
      );

    return {
      previous_owner_id: callerUserId,
      new_owner_id: targetUserId,
      org_id: orgId,
    };
  });
}

/** Lists a user's project memberships within a single org. Returns null if
 *  the user isn't a member of this org. */
export async function getMemberProjectsInOrg(orgId: string, userId: string) {
  const membershipRole = await getMembershipRole(orgId, userId);
  if (membershipRole === null) return null;

  const rows = await db
    .select({
      project_id: projects.id,
      project_name: projects.name,
      project_slug: projects.slug,
      role: projectMemberships.role,
      joined_at: projectMemberships.joined_at,
      is_archived: projects.is_archived,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.project_id, projects.id))
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        eq(projects.org_id, orgId),
      ),
    )
    .orderBy(projects.name);

  return rows;
}

/** Error raised when a project-membership operation finds a project in a
 *  different org than the caller's current org. */
export class CrossOrgProjectError extends Error {
  constructor(public readonly projectIds: string[]) {
    super(`Project(s) not in current org: ${projectIds.join(', ')}`);
    this.name = 'CrossOrgProjectError';
  }
}

/** Bulk-add a user to multiple projects in the caller's current org.
 *  Existing memberships are skipped (no role change). Returns lists of
 *  added vs. skipped project IDs. */
export async function addMemberToProjects(
  orgId: string,
  userId: string,
  assignments: { project_id: string; role: 'admin' | 'member' | 'viewer' }[],
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{ added: string[]; skipped: string[] }> {
  const targetRole = await getMembershipRole(orgId, userId);
  if (targetRole === null) {
    // Signal "target not a member" via a sentinel — route returns 404.
    throw new InsufficientRankError('Target user is not a member of this organization');
  }

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  const projectIds = assignments.map((a) => a.project_id);
  const bad = await findCrossOrgProjects(orgId, projectIds);
  if (bad.length > 0) throw new CrossOrgProjectError(bad);

  // Find which memberships already exist so we can classify added vs skipped.
  const existing = await db
    .select({ project_id: projectMemberships.project_id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        inArray(projectMemberships.project_id, projectIds),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.project_id));

  const toInsert = assignments.filter((a) => !existingSet.has(a.project_id));
  if (toInsert.length > 0) {
    // ON CONFLICT DO NOTHING guards against concurrent inserts racing.
    await db
      .insert(projectMemberships)
      .values(
        toInsert.map((a) => ({
          project_id: a.project_id,
          user_id: userId,
          role: a.role,
        })),
      )
      .onConflictDoNothing({
        target: [projectMemberships.project_id, projectMemberships.user_id],
      });
  }

  return {
    added: toInsert.map((a) => a.project_id),
    skipped: assignments.filter((a) => existingSet.has(a.project_id)).map((a) => a.project_id),
  };
}

/** Update a user's role on a single project in the caller's current org. */
export async function updateMemberProjectRole(
  orgId: string,
  userId: string,
  projectId: string,
  role: 'admin' | 'member' | 'viewer',
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{ project_id: string; user_id: string; role: string } | null> {
  const targetRole = await getMembershipRole(orgId, userId);
  if (targetRole === null) return null;

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  const bad = await findCrossOrgProjects(orgId, [projectId]);
  if (bad.length > 0) throw new CrossOrgProjectError(bad);

  const [updated] = await db
    .update(projectMemberships)
    .set({ role })
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        eq(projectMemberships.project_id, projectId),
      ),
    )
    .returning({
      project_id: projectMemberships.project_id,
      user_id: projectMemberships.user_id,
      role: projectMemberships.role,
    });

  return updated ?? null;
}

/** Assert the caller's rank is strictly above the target's membership role
 *  in the given org. Throws InsufficientRankError / returns false-sentinel
 *  if the target isn't a member of the org. */
async function assertRankOverMember(
  orgId: string,
  targetUserId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{ ok: true; targetRole: string } | { ok: false }> {
  const targetRole = await getMembershipRole(orgId, targetUserId);
  if (targetRole === null) return { ok: false };
  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }
  return { ok: true, targetRole };
}

/** Flip users.force_password_change = true for the target. */
export async function forcePasswordChange(
  orgId: string,
  targetUserId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{ user_id: string; force_password_change: true } | null> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  const [updated] = await db
    .update(users)
    .set({ force_password_change: true, updated_at: new Date() })
    .where(eq(users.id, targetUserId))
    .returning({ id: users.id });

  if (!updated) return null;
  return { user_id: updated.id, force_password_change: true };
}

/**
 * Clear the target's first-time-user flag (`notification_prefs.ftue_completed`)
 * so they re-run the welcome tour on their next sign-in. The rest of the
 * target's notification prefs are preserved (we drop only that one key). An
 * admin may reset themselves (innocuous) or any member they outrank.
 */
export async function resetMemberFtue(
  orgId: string,
  targetUserId: string,
  opts: { callerId: string; callerRole: string; callerIsSuperuser: boolean },
): Promise<{ user_id: string; ftue_completed: false } | null> {
  if (targetUserId !== opts.callerId) {
    const check = await assertRankOverMember(orgId, targetUserId, opts);
    if (!check.ok) return null;
  } else {
    // Self-reset: no rank gate, but the caller must still belong to the org.
    const role = await getMembershipRole(orgId, targetUserId);
    if (role === null) return null;
  }

  const [target] = await db
    .select({ prefs: users.notification_prefs })
    .from(users)
    .where(eq(users.id, targetUserId));
  if (!target) return null;

  const prefs = { ...((target.prefs as Record<string, unknown> | null) ?? {}) };
  delete prefs.ftue_completed;

  const [updated] = await db
    .update(users)
    .set({ notification_prefs: prefs, updated_at: new Date() })
    .where(eq(users.id, targetUserId))
    .returning({ id: users.id });

  if (!updated) return null;
  return { user_id: updated.id, ftue_completed: false };
}

/** Delete every session owned by the target user. */
export async function signOutMemberEverywhere(
  orgId: string,
  targetUserId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{ revoked: number } | null> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.user_id, targetUserId))
    .returning({ id: sessions.id });

  return { revoked: deleted.length };
}

/** List api_keys metadata for the target user, scoped to the current org. */
export async function listMemberApiKeys(
  orgId: string,
  targetUserId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<
  | {
      id: string;
      name: string;
      key_prefix: string;
      scope: string;
      project_ids: string[] | null;
      expires_at: Date | null;
      created_at: Date;
      last_used_at: Date | null;
    }[]
  | null
> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      key_prefix: apiKeys.key_prefix,
      scope: apiKeys.scope,
      project_ids: apiKeys.project_ids,
      expires_at: apiKeys.expires_at,
      created_at: apiKeys.created_at,
      last_used_at: apiKeys.last_used_at,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.user_id, targetUserId), eq(apiKeys.org_id, orgId)))
    .orderBy(apiKeys.created_at);

  return rows;
}

/** Create an API key on behalf of the target user, scoped to the current org. */
export async function createMemberApiKey(
  orgId: string,
  targetUserId: string,
  data: {
    name: string;
    scope: 'read' | 'read_write' | 'admin';
    project_ids?: string[];
    expires_days?: number;
  },
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{
  id: string;
  name: string;
  scope: string;
  key_prefix: string;
  project_ids: string[] | null;
  expires_at: Date | null;
  created_at: Date;
  token: string;
} | null> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  if (data.project_ids && data.project_ids.length > 0) {
    const bad = await findCrossOrgProjects(orgId, data.project_ids);
    if (bad.length > 0) throw new CrossOrgProjectError(bad);
  }

  const rawToken = `bbam_${randomBytes(32).toString('base64url')}`;
  const keyPrefix = rawToken.slice(0, 8);
  const keyHash = await argon2.hash(rawToken);

  const expiresAt =
    data.expires_days && data.expires_days > 0
      ? new Date(Date.now() + data.expires_days * 86_400_000)
      : null;

  const [row] = await db
    .insert(apiKeys)
    .values({
      user_id: targetUserId,
      org_id: orgId,
      name: data.name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scope: data.scope,
      project_ids: data.project_ids ?? null,
      expires_at: expiresAt,
    })
    .returning();

  return {
    id: row!.id,
    name: row!.name,
    scope: row!.scope,
    key_prefix: row!.key_prefix,
    project_ids: row!.project_ids,
    expires_at: row!.expires_at,
    created_at: row!.created_at,
    token: rawToken,
  };
}

/** Hard-delete an api_keys row. Returns false if not found / doesn't belong
 *  to the target user + current org (anti-enumeration). */
export async function deleteMemberApiKey(
  orgId: string,
  targetUserId: string,
  keyId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<boolean | null> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  const [deleted] = await db
    .delete(apiKeys)
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.user_id, targetUserId),
        eq(apiKeys.org_id, orgId),
      ),
    )
    .returning({ id: apiKeys.id });

  return deleted ? true : false;
}

/** Returns activity_log rows where actor_id = targetUserId, scoped to
 *  projects within the current org. Cursor is base64url of
 *  `${created_at_iso}|${id}` (DESC). */
export async function listMemberActivity(
  orgId: string,
  targetUserId: string,
  q: { limit: number; cursor: string | null },
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<{
  data: {
    id: string;
    project_id: string;
    project_name: string;
    task_id: string | null;
    action: string;
    details: unknown;
    created_at: Date;
    impersonator_id: string | null;
  }[];
  next_cursor: string | null;
} | null> {
  const check = await assertRankOverMember(orgId, targetUserId, opts);
  if (!check.ok) return null;

  const limit = Math.min(Math.max(q.limit, 1), 200);

  // Decode cursor.
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (q.cursor) {
    try {
      const decoded = Buffer.from(q.cursor, 'base64url').toString('utf8');
      const [ts, id] = decoded.split('|');
      if (ts && id) {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) {
          cursorCreatedAt = d;
          cursorId = id;
        }
      }
    } catch {
      // ignore malformed cursor and start from the beginning
    }
  }

  const conditions = [
    eq(activityLog.actor_id, targetUserId),
    eq(projects.org_id, orgId),
  ];
  if (cursorCreatedAt && cursorId) {
    // Strict DESC compound: (created_at, id) < (cursor_created_at, cursor_id)
    conditions.push(
      or(
        lt(activityLog.created_at, cursorCreatedAt),
        and(
          eq(activityLog.created_at, cursorCreatedAt),
          lt(activityLog.id, cursorId),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      id: activityLog.id,
      project_id: activityLog.project_id,
      project_name: projects.name,
      task_id: activityLog.task_id,
      action: activityLog.action,
      details: activityLog.details,
      created_at: activityLog.created_at,
      impersonator_id: activityLog.impersonator_id,
    })
    .from(activityLog)
    .innerJoin(projects, eq(activityLog.project_id, projects.id))
    .where(and(...conditions))
    .orderBy(desc(activityLog.created_at), desc(activityLog.id))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  const data = rows.slice(0, limit);
  if (rows.length > limit) {
    const last = data[data.length - 1]!;
    nextCursor = Buffer.from(
      `${last.created_at.toISOString()}|${last.id}`,
      'utf8',
    ).toString('base64url');
  }

  return { data, next_cursor: nextCursor };
}

/** Raised when the caller's current_password doesn't verify. */
export class InvalidCurrentPasswordError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'InvalidCurrentPasswordError';
  }
}

/** User changes their own password. Verifies current_password, hashes the
 *  new one, clears force_password_change, and invalidates all OTHER
 *  sessions for the user (keeping `currentSessionId` alive). */
export async function changeOwnPassword(opts: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  currentSessionId: string | null;
}): Promise<void> {
  const { userId, currentPassword, newPassword, currentSessionId } = opts;

  const [user] = await db
    .select({ id: users.id, password_hash: users.password_hash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || !user.password_hash) {
    throw new InvalidCurrentPasswordError();
  }

  const valid = await argon2.verify(user.password_hash, currentPassword);
  if (!valid) {
    throw new InvalidCurrentPasswordError();
  }

  const newHash = await argon2.hash(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        password_hash: newHash,
        force_password_change: false,
        updated_at: new Date(),
      })
      .where(eq(users.id, userId));

    // Invalidate all OTHER sessions for this user.
    if (currentSessionId) {
      await tx.execute(
        sql`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${currentSessionId}`,
      );
    } else {
      await tx.delete(sessions).where(eq(sessions.user_id, userId));
    }
  });
}

/** Remove a user from a single project in the caller's current org. */
export async function removeMemberFromProject(
  orgId: string,
  userId: string,
  projectId: string,
  opts: { callerRole: string; callerIsSuperuser: boolean },
): Promise<boolean | null> {
  const targetRole = await getMembershipRole(orgId, userId);
  if (targetRole === null) return null;

  const rank = checkRankAbove(opts.callerRole, targetRole, opts.callerIsSuperuser);
  if (!rank.allowed) {
    throw new InsufficientRankError(rank.reason);
  }

  const bad = await findCrossOrgProjects(orgId, [projectId]);
  if (bad.length > 0) throw new CrossOrgProjectError(bad);

  const [deleted] = await db
    .delete(projectMemberships)
    .where(
      and(
        eq(projectMemberships.user_id, userId),
        eq(projectMemberships.project_id, projectId),
      ),
    )
    .returning({ project_id: projectMemberships.project_id });

  return deleted ? true : false;
}
