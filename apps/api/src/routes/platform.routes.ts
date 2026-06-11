import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql, desc, ilike, and, isNull, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { escapeLike } from '../lib/escape-like.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { superuserAuditLog } from '../db/schema/superuser-audit-log.js';
import { notifications } from '../db/schema/notifications.js';
import { impersonationSessions } from '../db/schema/impersonation-sessions.js';
import { resolveOrgUserRoles, resolveUserOrgRole } from '../services/role-resolver.js';
import { seedDefaultPriorities } from '../services/priorities.service.js';
import { requireAuth } from '../plugins/auth.js';

const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const createOrgSchema = z.object({
  name: z.string().min(1).max(255),
  plan: z.string().max(50).default('free'),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  plan: z.string().max(50).optional(),
  settings: z.record(z.unknown()).optional(),
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

async function logSuperuserAction(
  superuserId: string,
  action: string,
  ip: string | undefined,
  details: Record<string, unknown> = {},
  targetOrgId?: string,
  targetUserId?: string,
) {
  try {
    await db.insert(superuserAuditLog).values({
      superuser_id: superuserId,
      action,
      target_org_id: targetOrgId ?? null,
      target_user_id: targetUserId ?? null,
      details,
      ip_address: ip ?? null,
    });
  } catch {
    // Non-critical: don't fail the request if audit logging fails
  }
}

/**
 * Platform administration routes — SuperUser only.
 * Provides cross-org management capabilities.
 */
export default async function platformRoutes(fastify: FastifyInstance) {
  // GET /v1/platform/orgs — list all organizations
  fastify.get(
    '/v1/platform/orgs',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org.list')] },
    async (request, reply) => {
      const query = request.query as { search?: string; limit?: string; offset?: string };
      const limit = Math.min(parseInt(query.limit || '50', 10), 100);
      const offset = parseInt(query.offset || '0', 10);

      let q = db
        .select({
          org: organizations,
          member_count: sql<number>`(SELECT count(*)::int FROM users WHERE org_id = ${organizations.id} AND is_active = true)`,
        })
        .from(organizations)
        .orderBy(desc(organizations.created_at))
        .limit(limit)
        .offset(offset);

      if (query.search) {
        q = q.where(ilike(organizations.name, `%${escapeLike(query.search)}%`)) as typeof q;
      }

      const orgs = await q;

      return reply.send({
        data: orgs.map((r) => ({ ...r.org, member_count: r.member_count })),
      });
    },
  );

  // POST /v1/platform/orgs — create a new organization
  fastify.post(
    '/v1/platform/orgs',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org.create')] },
    async (request, reply) => {
      const user = request.user!;
      const body = createOrgSchema.parse(request.body);
      const slug = slugify(body.name);

      const [org] = await db
        .insert(organizations)
        .values({
          name: body.name,
          slug,
          plan: body.plan,
        })
        .returning();

      await seedDefaultPriorities(db, org!.id);

      await logSuperuserAction(user.id, 'org.created', request.ip, {
        org_name: body.name,
        org_slug: slug,
      }, org!.id);

      return reply.status(201).send({ data: org });
    },
  );

  // GET /v1/platform/orgs/:id — get organization details
  fastify.get(
    '/v1/platform/orgs/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org.get')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1);

      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }

      const memberCount = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.org_id, id));

      return reply.send({
        data: { ...org, member_count: memberCount[0]?.count ?? 0 },
      });
    },
  );

  // PATCH /v1/platform/orgs/:id — update organization
  fastify.patch(
    '/v1/platform/orgs/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org.update')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = updateOrgSchema.parse(request.body);

      const updateData: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) {
        updateData.name = body.name;
        updateData.slug = slugify(body.name);
      }
      if (body.plan !== undefined) updateData.plan = body.plan;
      if (body.settings !== undefined) updateData.settings = body.settings;

      const [updated] = await db
        .update(organizations)
        .set(updateData)
        .where(eq(organizations.id, id))
        .returning();

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }

      await logSuperuserAction(user.id, 'org.updated', request.ip, body, id);

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/platform/orgs/:id — delete organization and all data
  fastify.delete(
    '/v1/platform/orgs/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org.delete')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, id))
        .limit(1);

      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }

      // P2-24: Invalidate all active sessions for users in this org BEFORE
      // the CASCADE delete runs. Otherwise, a user who is currently logged
      // in would continue to have a valid session cookie pointing at a
      // deleted user row until the session naturally expires.
      await db.execute(
        sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = ${id})`,
      );

      // CASCADE delete handles users, projects, etc.
      await db.delete(organizations).where(eq(organizations.id, id));

      await logSuperuserAction(user.id, 'org.deleted', request.ip, {
        org_name: org.name,
        org_slug: org.slug,
      }, id);

      return reply.send({ data: { success: true } });
    },
  );

  // GET /v1/platform/orgs/:id/members — list members of any org
  fastify.get(
    '/v1/platform/orgs/:id/members',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_org_member.get')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const members = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
          created_at: users.created_at,
          last_seen_at: users.last_seen_at,
        })
        .from(users)
        .where(eq(users.org_id, id))
        .orderBy(users.display_name);

      // Wave E.F: role is resolved from the org-scope group membership.
      const roleByUser = await resolveOrgUserRoles(id, members.map((m) => m.id));
      return reply.send({
        data: members.map((m) => ({ ...m, role: roleByUser.get(m.id) ?? 'member' })),
      });
    },
  );

  // PATCH /v1/platform/users/:id/superuser — toggle SuperUser status
  fastify.patch(
    '/v1/platform/users/:id/superuser',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_user_superuser.update')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const caller = request.user!;
      const body = z.object({ is_superuser: z.boolean() }).parse(request.body);

      if (id === caller.id && !body.is_superuser) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'Cannot remove your own SuperUser status', details: [], request_id: request.id },
        });
      }

      const [updated] = await db
        .update(users)
        .set({ is_superuser: body.is_superuser })
        .where(eq(users.id, id))
        .returning({ id: users.id, email: users.email, is_superuser: users.is_superuser });

      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'User not found', details: [], request_id: request.id },
        });
      }

      await logSuperuserAction(caller.id, body.is_superuser ? 'user.promoted_superuser' : 'user.demoted_superuser', request.ip, {}, undefined, id);

      return reply.send({ data: updated });
    },
  );

  // POST /v1/platform/impersonate — start impersonating a user
  fastify.post(
    '/v1/platform/impersonate',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_impersonate.create')] },
    async (request, reply) => {
      const caller = request.user!;
      const body = z.object({ user_id: z.string().uuid() }).parse(request.body);

      const [targetUserRow] = await db
        .select({
          id: users.id,
          org_id: users.org_id,
          email: users.email,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          timezone: users.timezone,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
          created_at: users.created_at,
          last_seen_at: users.last_seen_at,
        })
        .from(users)
        .where(eq(users.id, body.user_id))
        .limit(1);

      if (!targetUserRow) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'User not found', details: [], request_id: request.id },
        });
      }

      // Wave E.F: role resolved from the user's home-org group membership.
      const targetRole = await resolveUserOrgRole(targetUserRow.id, targetUserRow.org_id);
      const targetUser = { ...targetUserRow, role: targetRole ?? 'member' };

      if (targetUser.is_active === false) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'Cannot impersonate deactivated users', details: [], request_id: request.id },
        });
      }

      if (targetUser.is_superuser === true) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'Cannot impersonate other SuperUsers', details: [], request_id: request.id },
        });
      }

      await logSuperuserAction(
        caller.id,
        'user.impersonation_started',
        request.ip,
        { target_email: targetUser.email, target_name: targetUser.display_name },
        targetUser.org_id,
        targetUser.id,
      );

      // Create a time-limited impersonation session
      const now = new Date();
      const expires = new Date(now.getTime() + IMPERSONATION_TTL_MS);
      await db.insert(impersonationSessions).values({
        superuser_id: caller.id,
        target_user_id: targetUser.id,
        started_at: now,
        expires_at: expires,
      });

      // Notify the target user that their account was accessed
      try {
        await db.insert(notifications).values({
          user_id: targetUser.id,
          project_id: null,
          type: 'impersonation_started',
          title: 'Account access notification',
          body: `A platform administrator (${caller.display_name}) accessed your account.`,
        });
      } catch {
        // Non-critical
      }

      return reply.send({ data: targetUser });
    },
  );

  // POST /v1/platform/stop-impersonation — stop impersonating
  fastify.post(
    '/v1/platform/stop-impersonation',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_stop_impersonation.create')] },
    async (request, reply) => {
      if (!request.isImpersonating) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'Not currently impersonating', details: [], request_id: request.id },
        });
      }

      const impersonator = request.impersonator!;
      const impersonatedUser = request.user!;

      await logSuperuserAction(
        impersonator.id,
        'user.impersonation_stopped',
        request.ip,
        { target_email: impersonatedUser.email, target_name: impersonatedUser.display_name },
        impersonatedUser.org_id,
        impersonatedUser.id,
      );

      // End any active impersonation sessions for this pair
      await db
        .update(impersonationSessions)
        .set({ ended_at: new Date() })
        .where(
          and(
            eq(impersonationSessions.superuser_id, impersonator.id),
            eq(impersonationSessions.target_user_id, impersonatedUser.id),
            isNull(impersonationSessions.ended_at),
          ),
        );

      return reply.send({ data: { success: true } });
    },
  );

  // GET /v1/platform/impersonation-sessions — list active impersonation sessions
  fastify.get(
    '/v1/platform/impersonation-sessions',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_impersonation_session.list')] },
    async (_request, reply) => {
      const superuser = alias(users, 'superuser');
      const target = alias(users, 'target');
      const now = new Date();

      const rows = await db
        .select({
          id: impersonationSessions.id,
          superuser_id: impersonationSessions.superuser_id,
          target_user_id: impersonationSessions.target_user_id,
          started_at: impersonationSessions.started_at,
          expires_at: impersonationSessions.expires_at,
          superuser_name: superuser.display_name,
          superuser_email: superuser.email,
          target_name: target.display_name,
          target_email: target.email,
        })
        .from(impersonationSessions)
        .innerJoin(superuser, eq(impersonationSessions.superuser_id, superuser.id))
        .innerJoin(target, eq(impersonationSessions.target_user_id, target.id))
        .where(
          and(
            isNull(impersonationSessions.ended_at),
            gt(impersonationSessions.expires_at, now),
          ),
        )
        .orderBy(desc(impersonationSessions.started_at));

      return reply.send({ data: rows });
    },
  );

  // GET /v1/platform/audit-log — SuperUser audit trail
  fastify.get(
    '/v1/platform/audit-log',
    { preHandler: [requireAuth, fastify.requireCan('bam.platform_audit_log.list')] },
    async (request, reply) => {
      const query = request.query as { limit?: string; offset?: string };
      const limit = Math.min(parseInt(query.limit || '50', 10), 100);
      const offset = parseInt(query.offset || '0', 10);

      const logs = await db
        .select({
          log: superuserAuditLog,
          superuser_email: users.email,
          superuser_name: users.display_name,
        })
        .from(superuserAuditLog)
        .innerJoin(users, eq(superuserAuditLog.superuser_id, users.id))
        .orderBy(desc(superuserAuditLog.created_at))
        .limit(limit)
        .offset(offset);

      return reply.send({
        data: logs.map((r) => ({
          ...r.log,
          superuser_email: r.superuser_email,
          superuser_name: r.superuser_name,
        })),
      });
    },
  );
}
