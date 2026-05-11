import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { users } from '../db/schema/users.js';
import * as orgService from '../services/org.service.js';
import { checkOrgPermission, isOrgPrivileged } from '../services/org-permissions.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireOrgRole } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

export default async function orgRoutes(fastify: FastifyInstance) {
  fastify.get('/org', { preHandler: [requireAuth] }, async (request, reply) => {
    const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
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

    // The People UI needs these counts to render the "no active owner"
    // banner + a member-count badge. Returning them on the base /org
    // response avoids an extra round-trip.
    const counts = await orgService.getOrgMemberCounts(request.user!.org_id);

    return reply.send({
      data: {
        ...org,
        active_owner_count: counts.active_owner_count,
        member_count: counts.member_count,
      },
    });
  });

  fastify.patch(
    '/org',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org.update' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255).optional(),
        logo_url: z.string().url().nullable().optional(),
        settings: z.record(z.unknown()).optional(),
      });
      const data = schema.parse(request.body);

      const org = await orgService.updateOrganization(request.user!.org_id, data);
      // Drop the Redis-cached copy so the next reader picks up new settings.
      orgService.invalidateOrgCache(request.user!.org_id, fastify.redis);
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

      return reply.send({ data: org });
    },
  );

  fastify.get(
    '/org/members',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      // Guest users should only see members who share at least one project
      if (request.user!.role === 'guest') {
        // Find project IDs the guest belongs to
        const guestProjects = await db
          .select({ project_id: projectMemberships.project_id })
          .from(projectMemberships)
          .where(eq(projectMemberships.user_id, request.user!.id));

        if (guestProjects.length === 0) {
          // Guest has no project access — return only themselves
          const [self] = await db
            .select({
              id: users.id,
              email: users.email,
              display_name: users.display_name,
              avatar_url: users.avatar_url,
              role: users.role,
              is_active: users.is_active,
              created_at: users.created_at,
              last_seen_at: users.last_seen_at,
            })
            .from(users)
            .where(eq(users.id, request.user!.id))
            .limit(1);

          return reply.send({ data: self ? [self] : [] });
        }

        const projectIds = guestProjects.map((p) => p.project_id);

        // Find all user IDs who share at least one project with the guest
        const sharedMembers = await db
          .selectDistinct({ user_id: projectMemberships.user_id })
          .from(projectMemberships)
          .where(inArray(projectMemberships.project_id, projectIds));

        const sharedUserIds = sharedMembers.map((m) => m.user_id);

        const members = await db
          .select({
            id: users.id,
            email: users.email,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
            role: users.role,
            is_active: users.is_active,
            created_at: users.created_at,
            last_seen_at: users.last_seen_at,
          })
          .from(users)
          .where(
            and(
              eq(users.org_id, request.user!.org_id),
              inArray(users.id, sharedUserIds),
            ),
          )
          .orderBy(users.display_name);

        return reply.send({ data: members });
      }

      const members = await orgService.listOrgMembers(request.user!.org_id);
      return reply.send({ data: members });
    },
  );

  // Shared handler for translating service errors to HTTP responses.
  const handleRankError = (
    request: FastifyRequest,
    reply: FastifyReply,
    err: unknown,
  ): boolean => {
    if (err instanceof orgService.InsufficientRankError) {
      reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: err.message,
          details: [],
          request_id: request.id,
        },
      });
      return true;
    }
    if (err instanceof orgService.CrossOrgProjectError) {
      reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: err.message,
          details: err.projectIds.map((id) => ({ field: 'project_id', issue: `not in current org: ${id}` })),
          request_id: request.id,
        },
      });
      return true;
    }
    if (err instanceof orgService.VersionConflictError) {
      // P1-25: optimistic-concurrency conflict. Echo the current version
      // back so the client can refetch and retry without a round trip to
      // GET just to learn the new version.
      reply.status(409).send({
        error: {
          code: 'VERSION_CONFLICT',
          message: err.message,
          details: [{ field: 'version', current_version: err.currentVersion }],
          request_id: request.id,
        },
      });
      return true;
    }
    return false;
  };

  fastify.get<{ Params: { userId: string } }>(
    '/org/members/:userId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member.get' }), requireScope('admin')] },
    async (request, reply) => {
      const detail = await orgService.getOrgMemberDetail(
        request.user!.org_id,
        request.params.userId,
      );
      if (!detail) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Member not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: detail });
    },
  );

  fastify.patch<{ Params: { userId: string } }>(
    '/org/members/:userId/profile',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_profile.update' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        display_name: z.string().max(100).optional(),
        timezone: z.string().max(50).optional(),
      });
      const data = schema.parse(request.body ?? {});

      try {
        const updated = await orgService.updateMemberProfile(
          request.user!.org_id,
          request.params.userId,
          data,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (!updated) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: updated });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { userId: string } }>(
    '/org/members/:userId/active',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_active.update' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        is_active: z.boolean(),
        version: z.number().int().nonnegative().optional(),
      });
      const data = schema.parse(request.body);

      try {
        const result = await orgService.setMemberActive(
          request.user!.org_id,
          request.params.userId,
          data.is_active,
          {
            callerUserId: request.user!.id,
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
            expectedVersion: data.version,
          },
        );
        if (!result) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }

        request.log.info(
          {
            event: data.is_active ? 'admin.member_enabled' : 'admin.member_disabled',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
          },
          'Admin changed member active status',
        );

        return reply.send({ data: result });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/transfer-ownership',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_transfer_ownership.create' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const result = await orgService.transferOwnership({
          orgId: request.user!.org_id,
          callerUserId: request.user!.id,
          targetUserId: request.params.userId,
          callerIsSuperuser: request.user!.is_superuser,
        });

        request.log.info(
          {
            event: 'admin.ownership_transferred',
            caller_id: request.user!.id,
            previous_owner_id: result.previous_owner_id,
            new_owner_id: result.new_owner_id,
            org_id: result.org_id,
          },
          'Organization ownership transferred',
        );

        return reply.send({ data: result });
      } catch (err) {
        if (err instanceof orgService.TransferOwnershipError) {
          const status =
            err.code === 'TARGET_NOT_MEMBER'
              ? 404
              : err.code === 'CANNOT_TRANSFER_TO_SELF'
                ? 400
                : 403;
          return reply.status(status).send({
            error: {
              code:
                err.code === 'TARGET_NOT_MEMBER'
                  ? 'NOT_FOUND'
                  : err.code === 'CANNOT_TRANSFER_TO_SELF'
                    ? 'BAD_REQUEST'
                    : 'FORBIDDEN',
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  fastify.get<{ Params: { userId: string } }>(
    '/org/members/:userId/projects',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_project.get' }), requireScope('admin')] },
    async (request, reply) => {
      const rows = await orgService.getMemberProjectsInOrg(
        request.user!.org_id,
        request.params.userId,
      );
      if (rows === null) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Member not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: rows });
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/projects',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_project.create' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        assignments: z
          .array(
            z.object({
              project_id: z.string().uuid(),
              role: z.enum(['admin', 'member', 'viewer']),
            }),
          )
          .min(1),
      });
      const data = schema.parse(request.body);

      try {
        const result = await orgService.addMemberToProjects(
          request.user!.org_id,
          request.params.userId,
          data.assignments,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        return reply.send({ data: result });
      } catch (err) {
        if (
          err instanceof orgService.InsufficientRankError &&
          err.message === 'Target user is not a member of this organization'
        ) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { userId: string; projectId: string } }>(
    '/org/members/:userId/projects/:projectId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_project.update' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({ role: z.enum(['admin', 'member', 'viewer']) });
      const data = schema.parse(request.body);

      try {
        const updated = await orgService.updateMemberProjectRole(
          request.user!.org_id,
          request.params.userId,
          request.params.projectId,
          data.role,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (!updated) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Project membership not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: updated });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { userId: string; projectId: string } }>(
    '/org/members/:userId/projects/:projectId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_project.delete' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const removed = await orgService.removeMemberFromProject(
          request.user!.org_id,
          request.params.userId,
          request.params.projectId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (removed === null || removed === false) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Project membership not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: { success: true } });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/force-password-change',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_force_password_change.create' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const result = await orgService.forcePasswordChange(
          request.user!.org_id,
          request.params.userId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (!result) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        request.log.info(
          {
            event: 'admin.force_password_change',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
          },
          'Admin forced password change on next login',
        );
        return reply.send({ data: result });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/sign-out-everywhere',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_sign_out_everywhere.create' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const result = await orgService.signOutMemberEverywhere(
          request.user!.org_id,
          request.params.userId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (!result) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        request.log.info(
          {
            event: 'admin.sign_out_everywhere',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
            revoked: result.revoked,
          },
          'Admin revoked all sessions for target user',
        );
        return reply.send({ data: result });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.get<{ Params: { userId: string } }>(
    '/org/members/:userId/api-keys',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_api_key.get' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const rows = await orgService.listMemberApiKeys(
          request.user!.org_id,
          request.params.userId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (rows === null) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: rows });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/api-keys',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_api_key.create' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1).max(255),
        scope: z.enum(['read', 'read_write', 'admin']),
        project_ids: z.array(z.string().uuid()).optional(),
        expires_days: z.number().int().positive().max(3650).optional(),
      });
      const data = schema.parse(request.body);

      // Admin-scope keys may only be created by org owners or SuperUsers.
      // An org admin creating a key on behalf of another member cannot grant
      // admin scope — only owners can.
      if (
        data.scope === 'admin' &&
        !request.user!.is_superuser &&
        request.user!.role !== 'owner'
      ) {
        return reply.status(403).send({
          error: {
            code: 'ADMIN_SCOPE_OWNER_ONLY',
            message: "Admin-scope API keys can only be created by an organization owner.",
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const result = await orgService.createMemberApiKey(
          request.user!.org_id,
          request.params.userId,
          data,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (!result) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        request.log.info(
          {
            event: 'admin.api_key_created',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
            api_key_id: result.id,
            scope: result.scope,
          },
          'Admin created API key on behalf of member',
        );
        return reply.status(201).send({ data: result });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { userId: string; keyId: string } }>(
    '/org/members/:userId/api-keys/:keyId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_api_key.delete' }), requireScope('admin')] },
    async (request, reply) => {
      try {
        const removed = await orgService.deleteMemberApiKey(
          request.user!.org_id,
          request.params.userId,
          request.params.keyId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (removed === null || removed === false) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'API key not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        request.log.info(
          {
            event: 'admin.api_key_revoked',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
            api_key_id: request.params.keyId,
          },
          'Admin revoked API key on behalf of member',
        );
        return reply.send({ data: { success: true } });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.get<{
    Params: { userId: string };
    Querystring: { limit?: string; cursor?: string };
  }>(
    '/org/members/:userId/activity',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_activity.get' }), requireScope('admin')] },
    async (request, reply) => {
      const limit = Math.min(
        Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1),
        200,
      );
      const cursor = request.query.cursor ?? null;

      try {
        const result = await orgService.listMemberActivity(
          request.user!.org_id,
          request.params.userId,
          { limit, cursor },
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );
        if (result === null) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: result.data, next_cursor: result.next_cursor });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.post(
    '/org/members/invite',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      // Allow org admins/owners/superusers, OR members if the org permission
      // `members_can_invite_members` is enabled.
      if (!request.user!.is_superuser && !isOrgPrivileged(request.user!.role)) {
        const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
        const allowed = checkOrgPermission(
          org?.settings as Record<string, unknown> | null,
          'members_can_invite_members',
        );
        if (!allowed) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to invite other members',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const schema = z.object({
        email: z.string().email().max(320),
        role: z.enum(['member', 'admin']).default('member'),
        display_name: z.string().max(100).optional(),
        project_ids: z.array(z.string().uuid()).optional(),
      });
      const data = schema.parse(request.body);

      try {
        const { user, was_existing } = await orgService.inviteMember(
          request.user!.org_id,
          data.email,
          data.role,
          data.display_name,
        );
        // 201 CREATED for a brand-new user, 200 OK when we added an
        // existing user to this org as an additional membership.
        return reply.status(was_existing ? 200 : 201).send({
          data: { ...user, was_existing },
        });
      } catch (err: any) {
        if (err instanceof orgService.AlreadyMemberError) {
          return reply.status(409).send({
            error: {
              code: 'ALREADY_MEMBER',
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        if (err?.code === '23505') {
          // Residual unique-constraint race (two concurrent invites for the
          // same email). The second caller should retry and pick up the
          // just-created user via inviteMember's lookup path.
          return reply.status(409).send({
            error: {
              code: 'CONFLICT',
              message: 'A user with this email was just created by a concurrent request — please retry',
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // Bulk variant of /org/members/invite. Accepts up to 100 invites in one
  // request and processes them per-row (CSV-import-style): one bad row
  // doesn't fail the batch. Returns { succeeded, failed } so the UI can
  // show a per-row outcome table. Auth gate is identical to the single
  // endpoint, including the members_can_invite_members org setting.
  fastify.post(
    '/org/members/invite/bulk',
    {
      preHandler: [requireAuth, requireScope('admin')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!request.user!.is_superuser && !isOrgPrivileged(request.user!.role)) {
        const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
        const allowed = checkOrgPermission(
          org?.settings as Record<string, unknown> | null,
          'members_can_invite_members',
        );
        if (!allowed) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to invite other members',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const schema = z.object({
        invites: z
          .array(
            z.object({
              email: z.string().email().max(320),
              role: z.enum(['member', 'admin']).default('member'),
              display_name: z.string().max(100).optional(),
            }),
          )
          .min(1)
          .max(100),
      });
      const data = schema.parse(request.body);

      type Succeeded = Awaited<ReturnType<typeof orgService.inviteMember>>['user'] & {
        was_existing: boolean;
      };
      const succeeded: Succeeded[] = [];
      const failed: { email: string; code: string; message: string }[] = [];

      // De-dup within the batch: if the same email appears twice, the
      // second one fails with DUPLICATE_IN_BATCH so the caller can fix
      // their spreadsheet without producing a misleading ALREADY_MEMBER
      // error from the second row's DB attempt.
      const seen = new Set<string>();

      for (const row of data.invites) {
        const normalized = row.email.toLowerCase().trim();
        if (seen.has(normalized)) {
          failed.push({
            email: row.email,
            code: 'DUPLICATE_IN_BATCH',
            message: 'This email appears more than once in the batch',
          });
          continue;
        }
        seen.add(normalized);

        try {
          const { user, was_existing } = await orgService.inviteMember(
            request.user!.org_id,
            row.email,
            row.role,
            row.display_name,
          );
          succeeded.push({ ...user, was_existing });
        } catch (err: any) {
          if (err instanceof orgService.AlreadyMemberError) {
            failed.push({
              email: row.email,
              code: 'ALREADY_MEMBER',
              message: err.message,
            });
            continue;
          }
          if (err?.code === '23505') {
            failed.push({
              email: row.email,
              code: 'CONFLICT',
              message:
                'A user with this email was just created by a concurrent request — please retry',
            });
            continue;
          }
          // Unknown error — surface enough to debug but don't leak internals.
          request.log.error({ err, email: row.email }, 'bulk invite row failed');
          failed.push({
            email: row.email,
            code: 'INTERNAL_ERROR',
            message: 'Failed to invite this member — try again or invite individually',
          });
        }
      }

      return reply.status(200).send({
        data: {
          succeeded,
          failed,
          total_requested: data.invites.length,
          total_succeeded: succeeded.length,
          total_failed: failed.length,
        },
      });
    },
  );

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/reset-password',
    {
      preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member_reset_password.create' }), requireScope('admin')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const schema = z.object({
        password: z.string().min(12).max(200).optional(),
      });
      const data = schema.parse(request.body ?? {});

      try {
        const { user, password: _password } = await orgService.resetMemberPassword({
          orgId: request.user!.org_id,
          targetUserId: request.params.userId,
          callerUserId: request.user!.id,
          callerIsSuperuser: request.user!.is_superuser,
          callerRole: request.user!.role,
          newPassword: data.password ?? null,
        });

        request.log.info(
          {
            event: 'admin.password_reset',
            caller_id: request.user!.id,
            caller_email: request.user!.email,
            caller_is_superuser: request.user!.is_superuser,
            target_id: user.id,
            target_email: user.email,
            org_id: request.user!.org_id,
            generated: data.password === undefined,
          },
          'Admin reset another user password',
        );

        return reply.send({
          data: {
            user_id: user.id,
            email: user.email,
            generated: data.password === undefined,
            message: 'Password has been reset. The user will need to change it on next login.',
          },
        });
      } catch (err) {
        if (err instanceof orgService.PasswordResetForbiddenError) {
          const status = err.code === 'TARGET_NOT_FOUND' ? 404 : 403;
          return reply.status(status).send({
            error: {
              code: err.code === 'TARGET_NOT_FOUND' ? 'NOT_FOUND' : 'FORBIDDEN',
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { userId: string } }>(
    '/org/members/:userId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member.update' }), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        role: z.enum(['member', 'admin', 'viewer']),
        // P1-25: optional optimistic-concurrency token. Clients that send
        // it get 409 on stale writes; clients that omit it retain today's
        // last-write-wins behavior but still cause version to increment.
        version: z.number().int().nonnegative().optional(),
      });
      const data = schema.parse(request.body);

      try {
        const user = await orgService.updateMemberRole(
          request.user!.org_id,
          request.params.userId,
          data.role,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
            expectedVersion: data.version,
          },
        );

        if (!user) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }

        return reply.send({ data: user });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { userId: string } }>(
    '/org/members/:userId',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireOrgRole('admin', 'owner'), permission: 'bam.org_member.delete' }), requireScope('admin')] },
    async (request, reply) => {
      if (request.params.userId === request.user!.id) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'You cannot remove yourself from the organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const deleted = await orgService.removeMember(
          request.user!.org_id,
          request.params.userId,
          {
            callerRole: request.user!.role,
            callerIsSuperuser: request.user!.is_superuser,
          },
        );

        if (!deleted) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Member not found',
              details: [],
              request_id: request.id,
            },
          });
        }

        return reply.send({ data: { success: true } });
      } catch (err) {
        if (handleRankError(request, reply, err)) return;
        throw err;
      }
    },
  );
}
