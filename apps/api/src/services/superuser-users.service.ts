import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { escapeLike } from '../lib/escape-like.js';
import { organizations } from '../db/schema/organizations.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { setUserOrgRole } from './role-resolver.js';
import { superuserAuditLog } from '../db/schema/superuser-audit-log.js';
import { sessions } from '../db/schema/sessions.js';
import { projects } from '../db/schema/projects.js';
import { projectMemberships } from '../db/schema/project-memberships.js';

// ─── Cursor helpers (base64url JSON {created_at, id}) ───────────────────────

export interface UserCursor {
  created_at: string;
  id: string;
}

export function encodeUserCursor(c: UserCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeUserCursor(raw: string): UserCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<UserCursor>;
    if (
      typeof parsed.created_at === 'string' &&
      typeof parsed.id === 'string' &&
      parsed.id.length === 36
    ) {
      return { created_at: parsed.created_at, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Audit cursor helpers (base64url JSON {created_at, id}) ─────────────────

export function encodeAuditCursor(c: UserCursor): string {
  return encodeUserCursor(c);
}

export function decodeAuditCursor(raw: string): UserCursor | null {
  return decodeUserCursor(raw);
}

// ─── List users (cross-org) ────────────────────────────────────────────────

export interface ListUsersParams {
  search?: string;
  limit: number;
  cursor?: string;
  is_active?: boolean;
  is_superuser?: boolean;
}

export interface ListedUserOrg {
  org_id: string;
  name: string;
  slug: string;
  role: string;
  is_default: boolean;
}

export interface ListedUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_active: boolean;
  is_superuser: boolean;
  created_at: string;
  last_seen_at: string | null;
  orgs: ListedUserOrg[];
}

export async function listUsers(params: ListUsersParams): Promise<{
  data: ListedUser[];
  next_cursor: string | null;
}> {
  const { search, limit, cursor, is_active, is_superuser } = params;

  const conditions = [] as ReturnType<typeof eq>[];

  if (search) {
    conditions.push(
      (or(
        ilike(users.email, `%${escapeLike(search)}%`),
        ilike(users.display_name, `%${escapeLike(search)}%`),
      ) as unknown) as ReturnType<typeof eq>,
    );
  }
  if (typeof is_active === 'boolean') {
    conditions.push(eq(users.is_active, is_active));
  }
  if (typeof is_superuser === 'boolean') {
    conditions.push(eq(users.is_superuser, is_superuser));
  }
  if (cursor) {
    const c = decodeUserCursor(cursor);
    if (c) {
      conditions.push(
        (sql`("users"."created_at", "users"."id") < (${c.created_at}::timestamptz, ${c.id}::uuid)` as unknown) as ReturnType<typeof eq>,
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
      is_active: users.is_active,
      is_superuser: users.is_superuser,
      created_at: users.created_at,
      last_seen_at: users.last_seen_at,
    })
    .from(users)
    .where(whereClause)
    .orderBy(desc(users.created_at), desc(users.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (pageRows.length === 0) {
    return { data: [], next_cursor: null };
  }

  const userIds = pageRows.map((r) => r.id);
  // Wave E.F: role is resolved via account_group_memberships → permission_groups.
  const orgRows = await db
    .select({
      user_id: organizationMemberships.user_id,
      org_id: organizationMemberships.org_id,
      role: permissionGroups.legacy_role,
      is_default: organizationMemberships.is_default,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizationMemberships.org_id, organizations.id),
    )
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
      sql`${organizationMemberships.user_id} IN (${sql.join(
        userIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );

  const orgsByUser = new Map<string, ListedUserOrg[]>();
  for (const row of orgRows) {
    const arr = orgsByUser.get(row.user_id) ?? [];
    arr.push({
      org_id: row.org_id,
      name: row.name,
      slug: row.slug,
      role: row.role ?? 'member',
      is_default: row.is_default,
    });
    orgsByUser.set(row.user_id, arr);
  }

  const data: ListedUser[] = pageRows.map((r) => ({
    id: r.id,
    email: r.email,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    is_active: r.is_active,
    is_superuser: r.is_superuser,
    created_at: r.created_at.toISOString(),
    last_seen_at: r.last_seen_at ? r.last_seen_at.toISOString() : null,
    orgs: orgsByUser.get(r.id) ?? [],
  }));

  const last = pageRows[pageRows.length - 1]!;
  const next_cursor = hasMore
    ? encodeUserCursor({
        created_at: last.created_at.toISOString(),
        id: last.id,
      })
    : null;

  return { data, next_cursor };
}

// ─── Get user detail ───────────────────────────────────────────────────────

export interface UserDetail {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
  email_verified: boolean;
  pending_email: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
  disabled_by: { id: string; email: string; display_name: string } | null;
  memberships: Array<{
    org_id: string;
    org_name: string;
    org_slug: string;
    role: string;
    is_default: boolean;
    joined_at: string;
  }>;
  recent_audit: Array<{
    action: string;
    created_at: string;
    details: unknown;
  }>;
}

export async function getUserDetail(userId: string): Promise<UserDetail | null> {
  const [u] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!u) return null;

  let disabledBy: UserDetail['disabled_by'] = null;
  if (u.disabled_by) {
    const [d] = await db
      .select({
        id: users.id,
        email: users.email,
        display_name: users.display_name,
      })
      .from(users)
      .where(eq(users.id, u.disabled_by))
      .limit(1);
    disabledBy = d ?? null;
  }

  const mships = await db
    .select({
      org_id: organizationMemberships.org_id,
      org_name: organizations.name,
      org_slug: organizations.slug,
      role: permissionGroups.legacy_role,
      is_default: organizationMemberships.is_default,
      joined_at: organizationMemberships.joined_at,
    })
    .from(organizationMemberships)
    .innerJoin(
      organizations,
      eq(organizationMemberships.org_id, organizations.id),
    )
    .leftJoin(
      accountGroupMemberships,
      and(
        eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
        eq(accountGroupMemberships.scope_type, 'org'),
        eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
      ),
    )
    .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
    .where(eq(organizationMemberships.user_id, userId))
    .orderBy(desc(organizationMemberships.is_default), organizations.name);

  const audit = await db
    .select({
      action: superuserAuditLog.action,
      created_at: superuserAuditLog.created_at,
      details: superuserAuditLog.details,
    })
    .from(superuserAuditLog)
    .where(eq(superuserAuditLog.target_user_id, userId))
    .orderBy(desc(superuserAuditLog.created_at))
    .limit(20);

  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    timezone: u.timezone,
    is_active: u.is_active,
    is_superuser: u.is_superuser,
    email_verified: u.email_verified,
    pending_email: u.pending_email,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
    last_seen_at: u.last_seen_at ? u.last_seen_at.toISOString() : null,
    disabled_at: u.disabled_at ? u.disabled_at.toISOString() : null,
    disabled_by: disabledBy,
    memberships: mships.map((m) => ({
      org_id: m.org_id,
      org_name: m.org_name,
      org_slug: m.org_slug,
      role: m.role ?? 'member',
      is_default: m.is_default,
      joined_at: m.joined_at.toISOString(),
    })),
    recent_audit: audit.map((a) => ({
      action: a.action,
      created_at: a.created_at.toISOString(),
      details: a.details,
    })),
  };
}

// ─── Membership management ─────────────────────────────────────────────────

export async function userExists(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row);
}

export async function orgExists(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return Boolean(row);
}

export async function findMembership(userId: string, orgId: string) {
  const [row] = await db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function addMembership(
  userId: string,
  orgId: string,
  role: string,
): Promise<void> {
  // Wave E.F: role lives in account_group_memberships now.
  await db.transaction(async (tx) => {
    await tx.insert(organizationMemberships).values({
      user_id: userId,
      org_id: orgId,
      is_default: false,
    });
    await setUserOrgRole(userId, orgId, role, {}, tx);
  });
}

export async function removeMembership(
  userId: string,
  orgId: string,
): Promise<void> {
  await db
    .delete(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.user_id, userId),
        eq(organizationMemberships.org_id, orgId),
      ),
    );
}

export async function updateMembershipRole(
  userId: string,
  orgId: string,
  role: string,
): Promise<void> {
  // Wave E.F: role is stored in account_group_memberships. We still bump
  // the membership row's optimistic-concurrency token (P1-25) so any UI
  // holding a stale copy is forced to re-read.
  await db.transaction(async (tx) => {
    await setUserOrgRole(userId, orgId, role, {}, tx);
    await tx
      .update(organizationMemberships)
      .set({ version: sql`${organizationMemberships.version} + 1` })
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      );
  });
}

export async function countUserMemberships(userId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(organizationMemberships)
    .where(eq(organizationMemberships.user_id, userId));
  return row?.c ?? 0;
}

export async function setDefaultOrg(
  userId: string,
  orgId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Bump version on every membership row we touch (P1-25).
    await tx
      .update(organizationMemberships)
      .set({ is_default: false, version: sql`${organizationMemberships.version} + 1` })
      .where(eq(organizationMemberships.user_id, userId));
    await tx
      .update(organizationMemberships)
      .set({ is_default: true, version: sql`${organizationMemberships.version} + 1` })
      .where(
        and(
          eq(organizationMemberships.user_id, userId),
          eq(organizationMemberships.org_id, orgId),
        ),
      );
  });
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  created_at: string | null;
  expires_at: string;
  last_used_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  active_org_id: string | null;
}

export async function listUserSessions(
  userId: string,
): Promise<SessionRow[]> {
  const rows = await db
    .select({
      id: sessions.id,
      expires_at: sessions.expires_at,
      active_org_id: sessions.active_org_id,
    })
    .from(sessions)
    .where(eq(sessions.user_id, userId))
    .orderBy(desc(sessions.expires_at));

  return rows.map((r) => ({
    id: r.id,
    created_at: null,
    expires_at: r.expires_at.toISOString(),
    last_used_at: null,
    ip_address: null,
    user_agent: null,
    active_org_id: r.active_org_id,
  }));
}

export async function findUserSession(userId: string, sessionId: string) {
  const [row] = await db
    .select({ id: sessions.id, user_id: sessions.user_id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || row.user_id !== userId) return null;
  return row;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function deleteAllUserSessions(userId: string): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(eq(sessions.user_id, userId))
    .returning({ id: sessions.id });
  return result.length;
}

// ─── Email change ──────────────────────────────────────────────────────────

export async function findUserByEmail(email: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
}

export async function initiateEmailChange(
  userId: string,
  newEmail: string,
  token: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      pending_email: newEmail,
      email_verification_token: token,
      email_verification_sent_at: new Date(),
      email_verified: false,
    })
    .where(eq(users.id, userId));
}

export async function findUserByVerificationToken(token: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email_verification_token, token))
    .limit(1);
  return row ?? null;
}

export async function completeEmailVerification(
  userId: string,
  newEmail: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      email: newEmail,
      pending_email: null,
      email_verification_token: null,
      email_verified: true,
    })
    .where(eq(users.id, userId));
}

// ─── Projects for user ─────────────────────────────────────────────────────

export interface UserProjectRow {
  project_id: string;
  project_name: string;
  project_slug: string;
  org_id: string;
  org_name: string;
  role: string;
  joined_at: string;
  is_archived: boolean;
}

export async function listUserProjects(
  userId: string,
  scope: 'active' | 'all',
  callerActiveOrgId: string | null,
): Promise<UserProjectRow[]> {
  const conditions = [eq(projectMemberships.user_id, userId)] as ReturnType<typeof eq>[];

  if (scope === 'active' && callerActiveOrgId) {
    conditions.push(eq(projects.org_id, callerActiveOrgId));
  }

  const rows = await db
    .select({
      project_id: projects.id,
      project_name: projects.name,
      project_slug: projects.slug,
      org_id: projects.org_id,
      org_name: organizations.name,
      role: projectMemberships.role,
      joined_at: projectMemberships.joined_at,
      is_archived: projects.is_archived,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projectMemberships.project_id, projects.id))
    .innerJoin(organizations, eq(projects.org_id, organizations.id))
    .where(and(...conditions))
    .orderBy(organizations.name, projects.name);

  return rows.map((r) => ({
    project_id: r.project_id,
    project_name: r.project_name,
    project_slug: r.project_slug,
    org_id: r.org_id,
    org_name: r.org_name,
    role: r.role,
    joined_at: r.joined_at.toISOString(),
    is_archived: r.is_archived,
  }));
}

// ─── Audit log listing ─────────────────────────────────────────────────────

export interface AuditLogListParams {
  target_user_id?: string;
  superuser_id?: string;
  action?: string;
  limit: number;
  cursor?: string;
}

export interface AuditLogRow {
  id: string;
  superuser_id: string;
  action: string;
  target_org_id: string | null;
  target_user_id: string | null;
  details: unknown;
  ip_address: string | null;
  created_at: string;
}

export async function listAuditLog(params: AuditLogListParams): Promise<{
  data: AuditLogRow[];
  next_cursor: string | null;
}> {
  const conditions = [] as ReturnType<typeof eq>[];

  if (params.target_user_id) {
    conditions.push(eq(superuserAuditLog.target_user_id, params.target_user_id));
  }
  if (params.superuser_id) {
    conditions.push(eq(superuserAuditLog.superuser_id, params.superuser_id));
  }
  if (params.action) {
    conditions.push(eq(superuserAuditLog.action, params.action));
  }
  if (params.cursor) {
    const c = decodeAuditCursor(params.cursor);
    if (c) {
      conditions.push(
        (sql`("superuser_audit_log"."created_at", "superuser_audit_log"."id") < (${c.created_at}::timestamptz, ${c.id}::uuid)` as unknown) as ReturnType<typeof eq>,
      );
    }
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(superuserAuditLog)
    .where(whereClause)
    .orderBy(desc(superuserAuditLog.created_at), desc(superuserAuditLog.id))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;

  const data: AuditLogRow[] = pageRows.map((r) => ({
    id: r.id,
    superuser_id: r.superuser_id,
    action: r.action,
    target_org_id: r.target_org_id,
    target_user_id: r.target_user_id,
    details: r.details,
    ip_address: r.ip_address,
    created_at: r.created_at.toISOString(),
  }));

  const next_cursor =
    hasMore && pageRows.length > 0
      ? encodeAuditCursor({
          created_at: pageRows[pageRows.length - 1]!.created_at.toISOString(),
          id: pageRows[pageRows.length - 1]!.id,
        })
      : null;

  return { data, next_cursor };
}
