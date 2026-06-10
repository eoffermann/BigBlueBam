import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  superuserListOrgsQuerySchema,
  superuserSwitchContextSchema,
} from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { escapeLike } from '../lib/escape-like.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { projects } from '../db/schema/projects.js';
import { tasks } from '../db/schema/tasks.js';
import { tickets } from '../db/schema/tickets.js';
import { sessions } from '../db/schema/sessions.js';
import { loginHistory } from '../db/schema/login-history.js';
import { activityLog } from '../db/schema/activity-log.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { resolveUserOrgRole } from '../services/role-resolver.js';
import { betaSignupNotifications } from '../db/schema/beta-signup-notifications.js';
import {
  getPlatformSettings,
  setPublicSignupDisabled,
  setHelpdeskSignupDisabled,
} from '../services/platform-settings.service.js';
import { requireAuth } from '../plugins/auth.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';
import { setActiveOrgId, clearActiveOrgId } from '../services/session.service.js';
import {
  listUsers,
  getUserDetail,
  userExists,
  orgExists,
  findMembership,
  addMembership,
  removeMembership,
  updateMembershipRole,
  countUserMemberships,
  setDefaultOrg,
  listUserSessions,
  findUserSession,
  deleteSession,
  deleteAllUserSessions,
  findUserByEmail,
  initiateEmailChange,
  listUserProjects,
  listAuditLog,
} from '../services/superuser-users.service.js';
import {
  sendEmailVerificationEmail,
  sendEmailChangeNoticeEmail,
} from '../lib/email-queue.js';

const ROLE_VALUES = ['owner', 'admin', 'member', 'viewer', 'guest'] as const;
const roleSchema = z.enum(ROLE_VALUES);
const uuidSchema = z.string().uuid();

// ─── Cursor helpers (base64 JSON {created_at, id}) ──────────────────────────

interface OrgCursor {
  created_at: string;
  id: string;
}

function encodeCursor(c: OrgCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): OrgCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<OrgCursor>;
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

export default async function superuserRoutes(fastify: FastifyInstance) {
  // ─── GET /superuser/organizations ─────────────────────────────────────────
  fastify.get<{
    Querystring: { cursor?: string; limit?: string; search?: string };
  }>(
    '/organizations',
    { preHandler: [requireAuth, fastify.requireCan('bam.organization.list')] },
    async (request, reply) => {
      const parsed = superuserListOrgsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const limit = parsed.data.limit ?? 50;
      const search = parsed.data.search?.trim();

      const conditions = [] as ReturnType<typeof eq>[];
      if (search) {
        conditions.push(
          // Match either name or slug
          (or(
            ilike(organizations.name, `%${escapeLike(search)}%`),
            ilike(organizations.slug, `%${escapeLike(search)}%`),
          ) as unknown) as ReturnType<typeof eq>,
        );
      }

      if (parsed.data.cursor) {
        const c = decodeCursor(parsed.data.cursor);
        if (c) {
          // (created_at, id) DESC pagination: take rows strictly "after" the
          // cursor in DESC order. Use a single raw comparison so both columns
          // are qualified with the table name — Drizzle otherwise emits bare
          // "id" which collides with subquery-correlated references below.
          conditions.push(
            (sql`("organizations"."created_at", "organizations"."id") < (${c.created_at}::timestamptz, ${c.id}::uuid)` as unknown) as ReturnType<typeof eq>,
          );
        }
      }

      // Correlated subqueries use explicit quoted identifiers rather than
      // Drizzle `${table}` expansions — the expansions can emit bare column
      // names in subquery contexts that collide with the outer table's own
      // "id"/"org_id" columns, producing "column reference is ambiguous".
      const memberCountSq = sql<number>`(
        SELECT count(*)::int FROM "organization_memberships" om
        WHERE om."org_id" = "organizations"."id"
      )`;
      const projectCountSq = sql<number>`(
        SELECT count(*)::int FROM "projects" p
        WHERE p."org_id" = "organizations"."id"
      )`;
      const taskCountSq = sql<number>`(
        SELECT count(*)::int FROM "tasks" t
        INNER JOIN "projects" p ON t."project_id" = p."id"
        WHERE p."org_id" = "organizations"."id"
      )`;
      const lastActivitySq = sql<string | null>`(
        SELECT max(al."created_at")::text FROM "activity_log" al
        INNER JOIN "projects" p ON al."project_id" = p."id"
        WHERE p."org_id" = "organizations"."id"
      )`;

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
          created_at: organizations.created_at,
          member_count: memberCountSq,
          project_count: projectCountSq,
          task_count: taskCountSq,
          last_activity_at: lastActivitySq,
        })
        .from(organizations)
        .where(whereClause)
        .orderBy(desc(organizations.created_at), desc(organizations.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;

      const nextCursor =
        hasMore && data.length > 0
          ? encodeCursor({
              created_at: data[data.length - 1]!.created_at.toISOString(),
              id: data[data.length - 1]!.id,
            })
          : null;

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'org.list',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { search: search ?? null, limit, returned: data.length },
      });

      return reply.send({
        data: data.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          type: null,
          parent_org_id: null,
          created_at: r.created_at.toISOString(),
          member_count: r.member_count ?? 0,
          project_count: r.project_count ?? 0,
          task_count: r.task_count ?? 0,
          last_activity_at: r.last_activity_at ?? null,
        })),
        next_cursor: nextCursor,
      });
    },
  );

  // ─── GET /superuser/organizations/:id ────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/organizations/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.organization.get')] },
    async (request, reply) => {
      const { id } = request.params;

      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1);

      if (!org) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Organization not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Owners: users whose org-scope group membership maps to legacy_role='owner'.
      // Wave E.F: org_memberships.role was dropped — role lives in
      // account_group_memberships → permission_groups.
      const owners = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
        })
        .from(accountGroupMemberships)
        .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .innerJoin(users, eq(users.id, accountGroupMemberships.user_id))
        .where(
          and(
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, id),
            eq(permissionGroups.legacy_role, 'owner'),
          ),
        );

      // Project list with per-project task counts.
      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
          task_count: sql<number>`(
            SELECT count(*)::int FROM ${tasks}
            WHERE ${tasks.project_id} = ${projects.id}
          )`,
        })
        .from(projects)
        .where(eq(projects.org_id, id))
        .orderBy(projects.name);

      // Member counts grouped by role (resolved via group membership).
      const roleRows = await db
        .select({
          role: permissionGroups.legacy_role,
          count: sql<number>`count(*)::int`,
        })
        .from(accountGroupMemberships)
        .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, id),
          ),
        )
        .groupBy(permissionGroups.legacy_role);

      const memberCountsByRole: Record<string, number> = {};
      for (const r of roleRows) {
        if (r.role) memberCountsByRole[r.role] = r.count ?? 0;
      }

      // Recent activity tail (last 20 across all projects in this org).
      const recentActivity = await db
        .select({
          id: activityLog.id,
          project_id: activityLog.project_id,
          actor_id: activityLog.actor_id,
          action: activityLog.action,
          created_at: activityLog.created_at,
        })
        .from(activityLog)
        .innerJoin(projects, eq(activityLog.project_id, projects.id))
        .where(eq(projects.org_id, id))
        .orderBy(desc(activityLog.created_at))
        .limit(20);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'org.view',
        targetType: 'org',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });

      return reply.send({
        id: org.id,
        name: org.name,
        slug: org.slug,
        type: null,
        parent_org_id: null,
        plan: org.plan,
        logo_url: org.logo_url,
        settings: org.settings,
        created_at: org.created_at.toISOString(),
        updated_at: org.updated_at.toISOString(),
        owners,
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          task_count: p.task_count ?? 0,
        })),
        member_counts_by_role: memberCountsByRole,
        recent_activity: recentActivity.map((a) => ({
          id: a.id,
          project_id: a.project_id,
          actor_id: a.actor_id,
          action: a.action,
          created_at: a.created_at.toISOString(),
        })),
      });
    },
  );

  // ─── GET /superuser/overview ─────────────────────────────────────────────
  fastify.get(
    '/overview',
    { preHandler: [requireAuth, fastify.requireCan('bam.overview.list')] },
    async (request, reply) => {
      const now = new Date();
      // postgres-js cannot bind raw Date instances as parameters inside Drizzle
      // sql templates — pass ISO strings and cast to timestamptz server-side.
      const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [
        orgsCountRow,
        usersCountRow,
        activeSessionsRow,
        projectsCountRow,
        tasksCountRow,
        ticketsCountRow,
        banterChannelsRow,
        newUsers7Row,
        newUsers30Row,
        newOrgs7Row,
        newOrgs30Row,
      ] = await Promise.all([
        db.select({ c: sql<number>`count(*)::int` }).from(organizations),
        db.select({ c: sql<number>`count(*)::int` }).from(users),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(sessions)
          .where(sql`${sessions.expires_at} > now()`),
        db.select({ c: sql<number>`count(*)::int` }).from(projects),
        db.select({ c: sql<number>`count(*)::int` }).from(tasks),
        db.select({ c: sql<number>`count(*)::int` }).from(tickets),
        db.execute<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM banter_channels`,
        ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(users)
          .where(sql`${users.created_at} >= ${d7}::timestamptz`),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(users)
          .where(sql`${users.created_at} >= ${d30}::timestamptz`),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(organizations)
          .where(sql`${organizations.created_at} >= ${d7}::timestamptz`),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(organizations)
          .where(sql`${organizations.created_at} >= ${d30}::timestamptz`),
      ]);

      // db.execute returns a postgres-js result; banter_channels count is
      // extracted defensively because we don't have a Drizzle schema binding.
      let totalBanterChannels = 0;
      const banterRows = banterChannelsRow as unknown as Array<{ c: number }>;
      if (Array.isArray(banterRows) && banterRows.length > 0 && banterRows[0]) {
        totalBanterChannels = Number(banterRows[0].c) || 0;
      }

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'overview.view',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });

      return reply.send({
        total_orgs: orgsCountRow[0]?.c ?? 0,
        total_users: usersCountRow[0]?.c ?? 0,
        total_active_sessions: activeSessionsRow[0]?.c ?? 0,
        total_projects: projectsCountRow[0]?.c ?? 0,
        total_tasks: tasksCountRow[0]?.c ?? 0,
        total_tickets: ticketsCountRow[0]?.c ?? 0,
        total_banter_channels: totalBanterChannels,
        new_users_7d: newUsers7Row[0]?.c ?? 0,
        new_users_30d: newUsers30Row[0]?.c ?? 0,
        new_orgs_7d: newOrgs7Row[0]?.c ?? 0,
        new_orgs_30d: newOrgs30Row[0]?.c ?? 0,
      });
    },
  );

  // ─── POST /superuser/context/switch ──────────────────────────────────────
  fastify.post<{ Body: { org_id: string } }>(
    '/context/switch',
    {
      preHandler: [requireAuth, fastify.requireCan('bam.context.switch')],
    },
    async (request, reply) => {
      const parsed = superuserSwitchContextSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { org_id } = parsed.data;

      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, org_id))
        .limit(1);

      if (!org) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Organization not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await setActiveOrgId(request.sessionId!, org_id);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'context.switch',
        targetType: 'org',
        targetId: org_id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });

      return reply.send({ active_org_id: org_id });
    },
  );

  // ─── POST /superuser/context/clear ───────────────────────────────────────
  fastify.post(
    '/context/clear',
    { preHandler: [requireAuth, fastify.requireCan('bam.context_clear.create')] },
    async (request, reply) => {
      await clearActiveOrgId(request.sessionId!);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'context.clear',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });

      return reply.send({ ok: true });
    },
  );

  // ─── GET /superuser/users ────────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      search?: string;
      limit?: string;
      cursor?: string;
      is_active?: string;
      is_superuser?: string;
    };
  }>(
    '/users',
    { preHandler: [requireAuth, fastify.requireCan('bam.user.list')] },
    async (request, reply) => {
      const q = request.query;
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
        100,
      );
      const search = q.search?.trim() || undefined;
      const is_active =
        q.is_active === 'true' ? true : q.is_active === 'false' ? false : undefined;
      const is_superuser =
        q.is_superuser === 'true'
          ? true
          : q.is_superuser === 'false'
            ? false
            : undefined;

      const result = await listUsers({
        search,
        limit,
        cursor: q.cursor,
        is_active,
        is_superuser,
      });

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.list',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: {
          search: search ?? null,
          limit,
          returned: result.data.length,
          is_active: is_active ?? null,
          is_superuser: is_superuser ?? null,
        },
      });

      return reply.send(result);
    },
  );

  // ─── GET /superuser/users/:id ────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.user.get')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!uuidSchema.safeParse(id).success) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const detail = await getUserDetail(id);
      if (!detail) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.view',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });

      return reply.send({ data: detail });
    },
  );

  // ─── POST /superuser/users/:id/memberships ───────────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: { org_id: string; role: string };
  }>(
    '/users/:id/memberships',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_membership.create')] },
    async (request, reply) => {
      const { id } = request.params;
      const bodySchema = z.object({
        org_id: z.string().uuid(),
        role: roleSchema,
      });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (!(await orgExists(parsed.data.org_id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Organization not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const existing = await findMembership(id, parsed.data.org_id);
      if (existing) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'User is already a member of this organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      await addMembership(id, parsed.data.org_id, parsed.data.role);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.membership.add',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { org_id: parsed.data.org_id, role: parsed.data.role },
      });

      return reply.status(201).send({
        data: {
          user_id: id,
          org_id: parsed.data.org_id,
          role: parsed.data.role,
          is_default: false,
        },
      });
    },
  );

  // ─── DELETE /superuser/users/:id/memberships/:orgId ──────────────────────
  fastify.delete<{ Params: { id: string; orgId: string } }>(
    '/users/:id/memberships/:orgId',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_membership.delete')] },
    async (request, reply) => {
      const { id, orgId } = request.params;

      const existing = await findMembership(id, orgId);
      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Membership not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Wave E.F: role resolves via account_group_memberships → permission_groups.
      const previousRole = (await resolveUserOrgRole(id, orgId)) ?? 'member';

      const count = await countUserMemberships(id);
      if (count <= 1) {
        return reply.status(400).send({
          error: {
            code: 'LAST_MEMBERSHIP',
            message: 'Cannot remove the user\'s last organization membership',
            details: [],
            request_id: request.id,
          },
        });
      }

      await removeMembership(id, orgId);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.membership.remove',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { org_id: orgId, previous_role: previousRole },
      });

      return reply.status(204).send();
    },
  );

  // ─── PATCH /superuser/users/:id/memberships/:orgId ───────────────────────
  fastify.patch<{
    Params: { id: string; orgId: string };
    Body: { role: string };
  }>(
    '/users/:id/memberships/:orgId',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_membership.update')] },
    async (request, reply) => {
      const { id, orgId } = request.params;
      const bodySchema = z.object({ role: roleSchema });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const existing = await findMembership(id, orgId);
      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Membership not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Wave E.F: role resolves via account_group_memberships → permission_groups.
      const fromRole = (await resolveUserOrgRole(id, orgId)) ?? 'member';
      await updateMembershipRole(id, orgId, parsed.data.role);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.membership.role_change',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: {
          org_id: orgId,
          from_role: fromRole,
          to_role: parsed.data.role,
        },
      });

      return reply.send({
        data: {
          user_id: id,
          org_id: orgId,
          role: parsed.data.role,
          is_default: existing.is_default,
        },
      });
    },
  );

  // ─── POST /superuser/users/:id/set-default-org ───────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: { org_id: string };
  }>(
    '/users/:id/set-default-org',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_set_default_org.create')] },
    async (request, reply) => {
      const { id } = request.params;
      const bodySchema = z.object({ org_id: z.string().uuid() });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const existing = await findMembership(id, parsed.data.org_id);
      if (!existing) {
        return reply.status(400).send({
          error: {
            code: 'NOT_A_MEMBER',
            message: 'User is not a member of that organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      await setDefaultOrg(id, parsed.data.org_id);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.default_org.change',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { org_id: parsed.data.org_id },
      });

      return reply.send({
        data: { user_id: id, default_org_id: parsed.data.org_id },
      });
    },
  );

  // ─── GET /superuser/users/:id/sessions ───────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/users/:id/sessions',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_session.get')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rows = await listUserSessions(id);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.sessions.view',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { count: rows.length },
      });

      return reply.send({ data: rows });
    },
  );

  // ─── DELETE /superuser/users/:id/sessions/:sessionId ─────────────────────
  fastify.delete<{ Params: { id: string; sessionId: string } }>(
    '/users/:id/sessions/:sessionId',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_session.delete')] },
    async (request, reply) => {
      const { id, sessionId } = request.params;

      const found = await findUserSession(id, sessionId);
      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Session not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await deleteSession(sessionId);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.sessions.revoke',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { session_id: sessionId },
      });

      return reply.status(204).send();
    },
  );

  // ─── PATCH /superuser/users/:id/active ───────────────────────────────────
  fastify.patch<{
    Params: { id: string };
    Body: { is_active: boolean };
  }>(
    '/users/:id/active',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_active.update')] },
    async (request, reply) => {
      const { id } = request.params;
      const bodySchema = z.object({ is_active: z.boolean() });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const callerId = request.user!.id;
      const isActive = parsed.data.is_active;

      const result = await db.transaction(async (tx) => {
        if (isActive) {
          const [u] = await tx
            .update(users)
            .set({
              is_active: true,
              disabled_at: null,
              disabled_by: null,
              updated_at: new Date(),
            })
            .where(eq(users.id, id))
            .returning({
              id: users.id,
              is_active: users.is_active,
              disabled_at: users.disabled_at,
              disabled_by: users.disabled_by,
            });
          return u ?? null;
        }

        const [u] = await tx
          .update(users)
          .set({
            is_active: false,
            disabled_at: new Date(),
            disabled_by: callerId,
            updated_at: new Date(),
          })
          .where(eq(users.id, id))
          .returning({
            id: users.id,
            is_active: users.is_active,
            disabled_at: users.disabled_at,
            disabled_by: users.disabled_by,
          });
        await tx.delete(sessions).where(eq(sessions.user_id, id));
        return u ?? null;
      });

      if (!result) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await logSuperuserAction({
        superuserId: callerId,
        action: 'users.active.toggle',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { is_active: isActive },
      });

      return reply.send({
        data: {
          user_id: result.id,
          is_active: result.is_active,
          disabled_at: result.disabled_at,
          disabled_by: result.disabled_by,
        },
      });
    },
  );

  // ─── POST /superuser/users/:id/sessions/revoke-all ───────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/users/:id/sessions/revoke-all',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_session_revoke_all.create')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const revoked = await deleteAllUserSessions(id);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.sessions.revoke_all',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { revoked },
      });

      return reply.send({ data: { revoked } });
    },
  );

  // ─── PATCH /superuser/users/:id/email ────────────────────────────────────
  fastify.patch<{
    Params: { id: string };
    Body: { new_email: string };
  }>(
    '/users/:id/email',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_email.update')] },
    async (request, reply) => {
      const { id } = request.params;
      const bodySchema = z.object({
        new_email: z.string().email().max(320),
      });
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const newEmail = parsed.data.new_email.toLowerCase().trim();

      const [current] = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (!current) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check if the new email is already in use by another user.
      const taken = await findUserByEmail(newEmail);
      if (taken && taken.id !== id) {
        return reply.status(400).send({
          error: {
            code: 'EMAIL_TAKEN',
            message: 'That email is already in use',
            details: [],
            request_id: request.id,
          },
        });
      }

      const token = randomBytes(32).toString('base64url');

      await initiateEmailChange(id, newEmail, token);

      const verificationSent = await sendEmailVerificationEmail({
        to: newEmail,
        token,
        userName: current.display_name,
      });
      await sendEmailChangeNoticeEmail({
        to: current.email,
        userName: current.display_name,
        newEmail,
      });

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.email.change_requested',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { old_email: current.email, new_email: newEmail },
      });

      return reply.send({
        data: {
          user_id: id,
          pending_email: newEmail,
          email_sent: verificationSent,
        },
      });
    },
  );

  // ─── GET /superuser/users/:id/projects ───────────────────────────────────
  fastify.get<{
    Params: { id: string };
    Querystring: { scope?: string };
  }>(
    '/users/:id/projects',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_project.get')] },
    async (request, reply) => {
      const { id } = request.params;
      const scope: 'active' | 'all' =
        request.query.scope === 'all' ? 'all' : 'active';

      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const callerActiveOrgId = request.user?.active_org_id ?? null;
      const rows = await listUserProjects(id, scope, callerActiveOrgId);

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.projects.view',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: { scope, count: rows.length },
      });

      return reply.send({ data: rows });
    },
  );

  // ─── GET /superuser/audit-log ────────────────────────────────────────────
  fastify.get<{
    Querystring: {
      target_user_id?: string;
      superuser_id?: string;
      action?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/audit-log',
    { preHandler: [requireAuth, fastify.requireCan('bam.audit_log.list')] },
    async (request, reply) => {
      const q = request.query;
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
        200,
      );

      const result = await listAuditLog({
        target_user_id: q.target_user_id,
        superuser_id: q.superuser_id,
        action: q.action,
        limit,
        cursor: q.cursor,
      });

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'audit_log.view',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: {
          target_user_id: q.target_user_id ?? null,
          superuser_id: q.superuser_id ?? null,
          action_filter: q.action ?? null,
          limit,
          returned: result.data.length,
        },
      });

      return reply.send(result);
    },
  );

  // ─── GET /superuser/users/:id/login-history ──────────────────────────────
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; cursor?: string; success?: string };
  }>(
    '/users/:id/login-history',
    { preHandler: [requireAuth, fastify.requireCan('bam.user_login_history.get')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await userExists(id))) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const q = request.query;
      const limit = Math.min(
        Math.max(parseInt(q.limit ?? '50', 10) || 50, 1),
        200,
      );

      const conditions: ReturnType<typeof eq>[] = [
        eq(loginHistory.user_id, id),
      ];

      if (q.success === 'true' || q.success === 'false') {
        conditions.push(eq(loginHistory.success, q.success === 'true'));
      }

      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (c) {
          conditions.push(
            (sql`("login_history"."created_at", "login_history"."id") < (${c.created_at}::timestamptz, ${c.id}::uuid)` as unknown) as ReturnType<typeof eq>,
          );
        }
      }

      const rows = await db
        .select({
          id: loginHistory.id,
          user_id: loginHistory.user_id,
          email: loginHistory.email,
          ip_address: loginHistory.ip_address,
          user_agent: loginHistory.user_agent,
          success: loginHistory.success,
          failure_reason: loginHistory.failure_reason,
          created_at: loginHistory.created_at,
        })
        .from(loginHistory)
        .where(and(...conditions))
        .orderBy(desc(loginHistory.created_at), desc(loginHistory.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && data.length > 0
          ? encodeCursor({
              created_at: data[data.length - 1]!.created_at.toISOString(),
              id: data[data.length - 1]!.id,
            })
          : null;

      await logSuperuserAction({
        superuserId: request.user!.id,
        action: 'users.login_history.view',
        targetType: 'user',
        targetId: id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
        details: {
          limit,
          success_filter: q.success ?? null,
          returned: data.length,
        },
      });

      return reply.send({
        data: data.map((r) => ({
          ...r,
          created_at: r.created_at.toISOString(),
        })),
        next_cursor: nextCursor,
      });
    },
  );

  // ─── GET /superuser/platform-settings ────────────────────────────────────
  fastify.get(
    '/platform-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_setting.list')] },
    async () => {
      const settings = await getPlatformSettings();
      return {
        data: {
          public_signup_disabled: settings.public_signup_disabled === true,
          helpdesk_signup_disabled: settings.helpdesk_signup_disabled === true,
          updated_at: settings.updated_at?.toISOString() ?? null,
          updated_by: settings.updated_by,
        },
      };
    },
  );

  // ─── PATCH /superuser/platform-settings ──────────────────────────────────
  fastify.patch(
    '/platform-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_setting.update')] },
    async (request, reply) => {
      // Both flags are optional so the SuperUser UI can toggle them
      // independently without having to re-send the unchanged one.
      const schema = z
        .object({
          public_signup_disabled: z.boolean().optional(),
          helpdesk_signup_disabled: z.boolean().optional(),
        })
        .refine(
          (v) =>
            v.public_signup_disabled !== undefined ||
            v.helpdesk_signup_disabled !== undefined,
          { message: 'At least one flag must be provided' },
        );
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid payload',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const userId = request.user!.id;
      const changedFields: Record<string, boolean> = {};
      if (parsed.data.public_signup_disabled !== undefined) {
        await setPublicSignupDisabled(parsed.data.public_signup_disabled, userId);
        changedFields.public_signup_disabled = parsed.data.public_signup_disabled;
      }
      if (parsed.data.helpdesk_signup_disabled !== undefined) {
        await setHelpdeskSignupDisabled(parsed.data.helpdesk_signup_disabled, userId);
        changedFields.helpdesk_signup_disabled = parsed.data.helpdesk_signup_disabled;
      }
      await logSuperuserAction({
        superuserId: userId,
        action: 'update_platform_settings',
        details: changedFields,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? undefined,
      });
      const after = await getPlatformSettings();
      return reply.send({
        data: {
          public_signup_disabled: after.public_signup_disabled === true,
          helpdesk_signup_disabled: after.helpdesk_signup_disabled === true,
        },
      });
    },
  );

  // ─── GET /superuser/beta-signups ─────────────────────────────────────────
  fastify.get(
    '/beta-signups',
    { preHandler: [requireAuth, fastify.requireCan('bam.beta_signup.list')] },
    async () => {
      const rows = await db
        .select()
        .from(betaSignupNotifications)
        .orderBy(desc(betaSignupNotifications.created_at))
        .limit(1000);
      return {
        data: rows.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          message: r.message,
          ip_address: r.ip_address,
          created_at: r.created_at.toISOString(),
        })),
      };
    },
  );

  // ─── GET /superuser/calling-credentials ──────────────────────────────
  // Read-only summary of LiveKit + voice-agent provider configuration
  // for the SuperUser console's Platform tab. Reports whether the
  // platform is running on the published `devkey:secret` dev pair (the
  // template fallback), the public-facing LiveKit URL, and which STT /
  // LLM / TTS providers the voice-agent service has access to.
  //
  // The actual rotation of credentials happens by re-running the deploy
  // script — this endpoint is the visibility layer.
  fastify.get(
    '/superuser/calling-credentials',
    { preHandler: [requireAuth, fastify.requireCan('bam.superuser_calling_credential.list')] },
    async () => {
      const apiKey = process.env.LIVEKIT_API_KEY ?? '';
      // "devkey" is the literal placeholder fallback baked into the
      // livekit.yaml.template. Anything else is operator-supplied.
      const usingDevkey = !apiKey || apiKey === 'devkey';

      // STT / LLM / TTS providers come from the voice-agent's runtime
      // env (or its admin-pushed config). We surface env presence here
      // as a quick sanity check; the voice-agent's /config endpoint is
      // the source of truth at runtime.
      const stt = process.env.DEEPGRAM_API_KEY
        ? 'deepgram'
        : process.env.OPENAI_API_KEY
          ? 'openai'
          : null;
      const llm = process.env.LLM_PROVIDER
        ? process.env.LLM_PROVIDER
        : process.env.ANTHROPIC_API_KEY
          ? 'anthropic'
          : process.env.OPENAI_API_KEY
            ? 'openai'
            : null;
      const tts = process.env.OPENAI_API_KEY ? 'openai' : null;

      return {
        data: {
          using_devkey: usingDevkey,
          livekit_url: process.env.LIVEKIT_WS_URL || null,
          providers: { stt, llm, tts },
          // Per-knob env presence as seen by THIS (Bam api) container —
          // drives the "Configured at: env / settings / both" chips on the
          // Platform Calling Settings page. The system_settings half of
          // each chip comes from the per-key GET the page already does.
          env_presence: {
            'calling.livekit_host': !!process.env.LIVEKIT_WS_URL,
            'calling.livekit_api_key': !!process.env.LIVEKIT_API_KEY,
            'calling.livekit_api_secret': !!process.env.LIVEKIT_API_SECRET,
            'calling.voice_agent_url': !!process.env.VOICE_AGENT_URL,
          },
        },
      };
    },
  );
}
