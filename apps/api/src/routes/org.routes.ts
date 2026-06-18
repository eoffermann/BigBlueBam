import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { users } from '../db/schema/users.js';
import * as orgService from '../services/org.service.js';
import * as passwordResetService from '../services/password-reset.service.js';
import { checkOrgPermission, isOrgPrivileged } from '../services/org-permissions.js';
import { resolveOrgUserRoles } from '../services/role-resolver.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  sendMemberInvitationEmail,
  sendPasswordResetEmail,
  isSmtpConfigured,
} from '../lib/email-queue.js';
import {
  SMTP_SETTING_KEYS,
  clearOrgSmtpConfigCache,
  resolveSmtpHierarchy,
  type OrgSmtpOverride,
} from '@bigbluebam/smtp-resolver';
import nodemailer from 'nodemailer';
import { systemSettings } from '../db/schema/system-settings.js';
import { env } from '../env.js';
import {
  checkAdminDeletionEligibility,
  softDeleteUser,
  CannotDeleteSelfError,
  CannotDeleteSuperuserError,
  UserNotFoundError,
} from '../services/user-deletion.service.js';

export default async function orgRoutes(fastify: FastifyInstance) {
  fastify.get('/org', { preHandler: [requireAuth, shadowOnly('bam.org.list')] }, async (request, reply) => {
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org.update'), requireScope('admin')] },
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

  // ─── Per-org SMTP override (org admins/owners) ─────────────────────────
  // An org can configure its own outbound SMTP relay. When set, the org's
  // mail (Blast campaigns, member/guest invitations) sends through it; when
  // absent, it falls back to the platform relay (SuperUser Console → Platform
  // → SMTP) and finally the server env vars. Resolution lives in
  // @bigbluebam/smtp-resolver::resolveSmtpHierarchy.
  //
  // Stored in organizations.settings.smtp as a JSONB sub-object. These
  // dedicated routes are used INSTEAD of the generic PATCH /org so the
  // password never leaks on GET /org (which every member can read): the
  // password is masked on read and write-through here, behind the same
  // admin guard.

  // The mask sentinel echoed back on read; a PUT that sends this back
  // verbatim means "keep the stored password unchanged".
  const SMTP_PASSWORD_MASK = '••••••••';

  fastify.get(
    '/org/smtp-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.org.update'), requireScope('admin')] },
    async (request, reply) => {
      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }
      const smtp = ((org.settings ?? {}) as Record<string, unknown>).smtp as
        | Record<string, unknown>
        | undefined;
      const has = Boolean(smtp && typeof smtp.host === 'string' && smtp.host.length > 0);
      return reply.send({
        data: {
          configured: has,
          host: has ? (smtp!.host as string) : '',
          port:
            smtp && (typeof smtp.port === 'number' || typeof smtp.port === 'string')
              ? Number(smtp.port)
              : 587,
          user: has && typeof smtp!.user === 'string' ? (smtp!.user as string) : '',
          // Never return the stored password — surface a mask so the form
          // can render a "leave blank to keep" placeholder.
          password:
            smtp && typeof smtp.password === 'string' && smtp.password.length > 0
              ? SMTP_PASSWORD_MASK
              : '',
          from: has && typeof smtp!.from === 'string' ? (smtp!.from as string) : '',
          secure: Boolean(smtp && smtp.secure === true),
        },
      });
    },
  );

  fastify.put(
    '/org/smtp-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.org.update'), requireScope('admin')] },
    async (request, reply) => {
      const schema = z.object({
        host: z.string().max(255),
        port: z.union([
          z.number().int().min(1).max(65535),
          z.string().regex(/^\d+$/),
        ]),
        user: z.string().max(255).optional().default(''),
        // May be the mask sentinel (keep existing), empty (clear), or a new value.
        password: z.string().max(512).optional().default(''),
        from: z.string().max(320).optional().default(''),
        secure: z.boolean().optional().default(false),
      });
      const data = schema.parse(request.body);

      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }
      const existingSettings = (org.settings ?? {}) as Record<string, unknown>;
      const existingSmtp = (existingSettings.smtp ?? {}) as Record<string, unknown>;

      // Password handling: the mask sentinel means keep the stored value; an
      // empty string means clear it; anything else replaces it.
      let password: string;
      if (data.password === SMTP_PASSWORD_MASK) {
        password = typeof existingSmtp.password === 'string' ? existingSmtp.password : '';
      } else {
        password = data.password;
      }

      const nextSmtp = {
        host: data.host.trim(),
        port: Number(data.port),
        user: data.user,
        password,
        from: data.from,
        secure: data.secure,
      };

      await orgService.updateOrganization(request.user!.org_id, {
        settings: { ...existingSettings, smtp: nextSmtp },
      });
      orgService.invalidateOrgCache(request.user!.org_id, fastify.redis);
      // Drop the per-org SMTP resolver cache so the next send sees the change
      // immediately rather than at the 30s TTL boundary.
      clearOrgSmtpConfigCache(request.user!.org_id);

      request.log.info(
        { event: 'org.smtp_override_updated', org_id: request.user!.org_id, host: nextSmtp.host },
        'Org SMTP override updated',
      );

      return reply.send({
        data: {
          configured: nextSmtp.host.length > 0,
          host: nextSmtp.host,
          port: nextSmtp.port,
          user: nextSmtp.user,
          password: password.length > 0 ? SMTP_PASSWORD_MASK : '',
          from: nextSmtp.from,
          secure: nextSmtp.secure,
        },
      });
    },
  );

  fastify.delete(
    '/org/smtp-settings',
    { preHandler: [requireAuth, fastify.requireCan('bam.org.update'), requireScope('admin')] },
    async (request, reply) => {
      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      if (!org) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Organization not found', details: [], request_id: request.id },
        });
      }
      const existingSettings = (org.settings ?? {}) as Record<string, unknown>;
      // Drop the smtp key entirely so resolution falls back to the platform.
      const { smtp: _removed, ...rest } = existingSettings;
      void _removed;
      await orgService.updateOrganization(request.user!.org_id, { settings: rest });
      orgService.invalidateOrgCache(request.user!.org_id, fastify.redis);
      clearOrgSmtpConfigCache(request.user!.org_id);
      request.log.info(
        { event: 'org.smtp_override_cleared', org_id: request.user!.org_id },
        'Org SMTP override cleared — reverting to platform relay',
      );
      return reply.send({ data: { configured: false } });
    },
  );

  // POST /org/smtp-settings/test — verify the EFFECTIVE org relay connects.
  // Resolves org → platform → env exactly the way the worker will, then runs
  // a transport.verify() (login + TLS handshake) so an admin can confirm
  // their relay works before a campaign rides it. Connection-only by default;
  // pass `{ to }` to also send a one-line test message.
  fastify.post(
    '/org/smtp-settings/test',
    { preHandler: [requireAuth, fastify.requireCan('bam.org.update'), requireScope('admin')] },
    async (request, reply) => {
      const bodySchema = z.object({ to: z.string().email().max(320).optional() });
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Body validation failed',
            details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
            request_id: request.id,
          },
        });
      }
      const { to } = parsed.data;

      const org = await orgService.getOrganizationCached(fastify.redis, request.user!.org_id);
      const orgSmtp = ((org?.settings ?? {}) as Record<string, unknown>).smtp as
        | OrgSmtpOverride
        | undefined;

      // Load the platform smtp_* rows so the fallback layer resolves the same
      // way the worker sees it.
      const rows = await db
        .select({ key: systemSettings.key, value: systemSettings.value })
        .from(systemSettings)
        .where(inArray(systemSettings.key, [...SMTP_SETTING_KEYS]));
      const platformSettings: Record<string, unknown> = {};
      for (const r of rows) platformSettings[r.key] = r.value;

      const cfg = resolveSmtpHierarchy(orgSmtp, platformSettings, {
        SMTP_HOST: env.SMTP_HOST,
        SMTP_PORT: env.SMTP_PORT,
        SMTP_USER: env.SMTP_USER,
        SMTP_PASS: env.SMTP_PASS,
        EMAIL_FROM: env.EMAIL_FROM,
      });

      if (!cfg) {
        return reply.status(400).send({
          data: {
            ok: false,
            stage: 'config',
            error:
              'No SMTP relay resolves for this org (no org override, no platform relay, no env vars). Configure an org relay above or ask a SuperUser to set the platform relay.',
          },
        });
      }

      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });

      try {
        await transport.verify();
      } catch (err) {
        const e = err as Error & { code?: string };
        request.log.warn({ err: e, stage: 'verify', smtp_layer: cfg.layer }, 'Org SMTP test failed (verify)');
        return reply.send({
          data: {
            ok: false,
            stage: 'verify',
            error_code: e.code ?? null,
            error: e.message,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, layer: cfg.layer },
          },
        });
      }

      if (!to) {
        transport.close();
        return reply.send({
          data: {
            ok: true,
            stage: 'verify',
            message: `Connected to ${cfg.host}:${cfg.port} (${cfg.secure ? 'TLS' : 'STARTTLS'}) via the ${cfg.layer} relay.`,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, layer: cfg.layer },
          },
        });
      }

      try {
        const info = await transport.sendMail({
          from: cfg.from,
          to,
          subject: 'BigBlueBam org SMTP test',
          text:
            'This is a test message from your BigBlueBam organization SMTP settings. ' +
            'If you received it, your org relay is configured correctly.\n',
        });
        return reply.send({
          data: {
            ok: true,
            stage: 'send',
            message: `Test email accepted by ${cfg.host} for delivery to ${to}. Message id: ${info.messageId}`,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, layer: cfg.layer },
          },
        });
      } catch (err) {
        const e = err as Error & { code?: string; response?: string };
        request.log.warn({ err: e, stage: 'send', smtp_layer: cfg.layer }, 'Org SMTP test failed (send)');
        return reply.send({
          data: {
            ok: false,
            stage: 'send',
            error_code: e.code ?? null,
            error: e.message,
            server_response: e.response ?? null,
            resolved: { host: cfg.host, port: cfg.port, secure: cfg.secure, layer: cfg.layer },
          },
        });
      } finally {
        transport.close();
      }
    },
  );

  fastify.get(
    '/org/members',
    { preHandler: [requireAuth, shadowOnly('bam.org_member.list')] },
    async (request, reply) => {
      // Guest users should only see members who share at least one project
      if (request.user!.role === 'guest') {
        // Find project IDs the guest belongs to
        const guestProjects = await db
          .select({ project_id: projectMemberships.project_id })
          .from(projectMemberships)
          .where(eq(projectMemberships.user_id, request.user!.id));

        if (guestProjects.length === 0) {
          // Guest has no project access — return only themselves. Wave E.F:
          // role is the caller's resolved per-org role (already on the
          // AuthUser).
          const [self] = await db
            .select({
              id: users.id,
              email: users.email,
              display_name: users.display_name,
              avatar_url: users.avatar_url,
              is_active: users.is_active,
              created_at: users.created_at,
              last_seen_at: users.last_seen_at,
            })
            .from(users)
            .where(eq(users.id, request.user!.id))
            .limit(1);

          return reply.send({
            data: self ? [{ ...self, role: request.user!.role }] : [],
          });
        }

        const projectIds = guestProjects.map((p) => p.project_id);

        // Find all user IDs who share at least one project with the guest
        const sharedMembers = await db
          .selectDistinct({ user_id: projectMemberships.user_id })
          .from(projectMemberships)
          .where(inArray(projectMemberships.project_id, projectIds));

        const sharedUserIds = sharedMembers.map((m) => m.user_id);

        // Wave E.F: role is resolved from the org-scope group membership.
        const memberRoles = await resolveOrgUserRoles(
          request.user!.org_id,
          sharedUserIds,
        );

        const members = await db
          .select({
            id: users.id,
            email: users.email,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
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

        return reply.send({
          data: members.map((m) => ({ ...m, role: memberRoles.get(m.id) ?? 'member' })),
        });
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member.get'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_profile.update'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_active.update'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_transfer_ownership.create'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_project.get'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_project.create'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_project.update'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_project.delete'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_force_password_change.create'), requireScope('admin')] },
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
    '/org/members/:userId/reset-ftue',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      try {
        const result = await orgService.resetMemberFtue(
          request.user!.org_id,
          request.params.userId,
          {
            callerId: request.user!.id,
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
            event: 'admin.reset_ftue',
            caller_id: request.user!.id,
            target_id: request.params.userId,
            org_id: request.user!.org_id,
          },
          'Admin reset the welcome tour (FTUE) for member',
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_sign_out_everywhere.create'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_api_key.get'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_api_key.create'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_api_key.delete'), requireScope('admin')] },
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
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member_activity.get'), requireScope('admin')] },
    async (request, reply) => {
      const limit = Math.min(
        Math.max(Number.parseInt(request.query.limit ?? '50', 10) || 50, 1),
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
    { preHandler: [requireAuth, requireScope('admin'), shadowOnly('bam.org_member.invite')] },
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
        const { user, was_existing, projects_added, projects_skipped } =
          await orgService.inviteMember(
            request.user!.org_id,
            data.email,
            data.role,
            data.display_name,
            data.project_ids,
          );

        // Send the invitation email. For brand-new users (no password yet),
        // mint a password-reset token so they can set their own password
        // via the standard /password-reset page. For users who already
        // had an account elsewhere we just announce the new org access.
        const needsOnboarding = user.password_hash == null;
        let email_sent = false;
        try {
          const org = await orgService.getOrganizationCached(
            fastify.redis,
            request.user!.org_id,
          );
          const orgName = org?.name ?? 'BigBlueBam';
          const inviterName =
            request.user!.display_name || request.user!.email || 'A teammate';

          let onboardingToken: string | undefined;
          let onboardingTtl: number | undefined;
          if (needsOnboarding) {
            // Longer TTL for the very first onboarding link (people may not
            // check email immediately).
            const minted = await passwordResetService.mintToken({
              userId: user.id,
              createdBy: request.user!.id,
              ipAddress: request.ip,
              purpose: 'invite',
              ttlMinutes: 60 * 24 * 7, // 7 days
            });
            onboardingToken = minted.token;
            onboardingTtl = 60 * 24 * 7;
          }

          email_sent = await sendMemberInvitationEmail({
            to: user.email,
            orgName,
            inviterName,
            invitedUserName: user.display_name || user.email,
            isNewUser: needsOnboarding,
            onboardingToken,
            onboardingExpiresInMinutes: onboardingTtl,
            orgId: request.user!.org_id,
          });
          if (!email_sent) {
            const smtpReady = await isSmtpConfigured();
            request.log.warn(
              {
                event: 'invite.email_not_sent',
                target_email: user.email,
                smtp_configured: smtpReady,
              },
              smtpReady
                ? 'Invitation email job failed to enqueue'
                : 'SMTP not configured — invitation email not sent',
            );
          } else {
            request.log.info(
              { event: 'invite.email_enqueued', target_email: user.email },
              'Invitation email enqueued for delivery',
            );
          }
        } catch (emailErr) {
          // Never let a flaky email pipeline roll back a successful invite.
          request.log.error(
            { err: emailErr, target_email: user.email },
            'Invitation email enqueue threw',
          );
        }

        // Drop password_hash from the response — clients should never see it.
        const { password_hash: _omit, ...safe } = user;
        // 201 CREATED for a brand-new user, 200 OK when we added an
        // existing user to this org as an additional membership.
        return reply.status(was_existing ? 200 : 201).send({
          data: {
            ...safe,
            was_existing,
            email_sent,
            projects_added,
            projects_skipped,
          },
        });
      } catch (err: any) {
        if (err instanceof orgService.CrossOrgProjectError) {
          return reply.status(400).send({
            error: {
              code: 'CROSS_ORG_PROJECT',
              message: 'One or more project_ids do not belong to this organization',
              details: err.projectIds.map((id) => ({ field: 'project_ids', issue: id })),
              request_id: request.id,
            },
          });
        }
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
      preHandler: [requireAuth, requireScope('admin'), shadowOnly('bam.org_member_invite_bulk.create')],
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
              project_ids: z.array(z.string().uuid()).optional(),
            }),
          )
          .min(1)
          .max(100),
        // Convenience: project_ids applied to every row that didn't
        // specify its own. Saves a UI from having to thread the same
        // assignment list through 50 rows.
        default_project_ids: z.array(z.string().uuid()).optional(),
      });
      const data = schema.parse(request.body);

      type SafeUser = Omit<
        Awaited<ReturnType<typeof orgService.inviteMember>>['user'],
        'password_hash'
      >;
      type Succeeded = SafeUser & {
        was_existing: boolean;
        email_sent: boolean;
        projects_added: string[];
        projects_skipped: string[];
      };
      const succeeded: Succeeded[] = [];
      const failed: { email: string; code: string; message: string }[] = [];

      // Resolve the inviter's display name and org name once for the batch.
      const org = await orgService.getOrganizationCached(
        fastify.redis,
        request.user!.org_id,
      );
      const orgName = org?.name ?? 'BigBlueBam';
      const inviterName =
        request.user!.display_name || request.user!.email || 'A teammate';

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
          const projectIds = row.project_ids ?? data.default_project_ids ?? [];
          const { user, was_existing, projects_added, projects_skipped } =
            await orgService.inviteMember(
              request.user!.org_id,
              row.email,
              row.role,
              row.display_name,
              projectIds,
            );
          const needsOnboarding = user.password_hash == null;
          let email_sent = false;
          try {
            let onboardingToken: string | undefined;
            let onboardingTtl: number | undefined;
            if (needsOnboarding) {
              const minted = await passwordResetService.mintToken({
                userId: user.id,
                createdBy: request.user!.id,
                ipAddress: request.ip,
                purpose: 'invite',
                ttlMinutes: 60 * 24 * 7,
              });
              onboardingToken = minted.token;
              onboardingTtl = 60 * 24 * 7;
            }
            email_sent = await sendMemberInvitationEmail({
              to: user.email,
              orgName,
              inviterName,
              invitedUserName: user.display_name || user.email,
              isNewUser: needsOnboarding,
              onboardingToken,
              onboardingExpiresInMinutes: onboardingTtl,
              orgId: request.user!.org_id,
            });
          } catch (emailErr) {
            request.log.error(
              { err: emailErr, target_email: user.email },
              'Bulk invitation email enqueue threw',
            );
          }
          const { password_hash: _omit, ...safe } = user;
          succeeded.push({
            ...safe,
            was_existing,
            email_sent,
            projects_added,
            projects_skipped,
          });
        } catch (err: any) {
          if (err instanceof orgService.CrossOrgProjectError) {
            failed.push({
              email: row.email,
              code: 'CROSS_ORG_PROJECT',
              message: `Project(s) not in current org: ${err.projectIds.join(', ')}`,
            });
            continue;
          }
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
      preHandler: [requireAuth, fastify.requireCan('bam.org_member_reset_password.create'), requireScope('admin')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const schema = z.object({
        password: z.string().min(12).max(200).optional(),
      });
      const data = schema.parse(request.body ?? {});

      try {
        const { user, password } = await orgService.resetMemberPassword({
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

        // Surface the new password to the admin once so they can share it
        // with the user out-of-band. The frontend renders it in a reveal-once
        // dialog with a clipboard copy and warns it won't be shown again.
        return reply.send({
          data: {
            user_id: user.id,
            email: user.email,
            password,
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

  fastify.post<{ Params: { userId: string } }>(
    '/org/members/:userId/send-password-reset',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.org_member_reset_password.create'),
        requireScope('admin'),
      ],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      // Same authorization model as direct password reset: a caller can
      // mint a reset link only for users they could have reset directly.
      // The rank check lives in resetMemberPassword today; we re-use the
      // shape but skip the actual password write and instead mint a token.
      const targetUserId = request.params.userId;
      if (targetUserId === request.user!.id) {
        return reply.status(400).send({
          error: {
            code: 'CANNOT_RESET_SELF',
            message:
              'Use the change-password flow to reset your own password — or trigger forgot-password from /login.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [target] = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
        })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

      if (!target) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Target user not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!request.user!.is_superuser) {
        // Reuse the rank logic from the direct-reset endpoint by attempting
        // it indirectly: read the target's membership role and compare.
        const targetRole = await orgService.getMembershipRole(
          request.user!.org_id,
          targetUserId,
        );
        if (!targetRole) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Target user is not a member of this org',
              details: [],
              request_id: request.id,
            },
          });
        }
        const rank = orgService.checkRankAbove(
          request.user!.role,
          targetRole,
          request.user!.is_superuser,
        );
        if (!rank.allowed) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message:
                rank.reason ??
                'You cannot send a password reset for a user at or above your own role',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const minted = await passwordResetService.mintToken({
        userId: target.id,
        createdBy: request.user!.id,
        ipAddress: request.ip,
        purpose: 'reset',
      });

      const ttlMinutes = Math.max(
        1,
        Math.round((minted.expiresAt.getTime() - Date.now()) / 60_000),
      );

      let email_sent = false;
      try {
        email_sent = await sendPasswordResetEmail({
          to: target.email,
          token: minted.token,
          userName: target.display_name || target.email,
          expiresInMinutes: ttlMinutes,
          orgId: request.user!.org_id,
        });
      } catch (emailErr) {
        request.log.error(
          { err: emailErr, target_email: target.email },
          'Send-password-reset email enqueue threw',
        );
      }

      const smtpReady = await isSmtpConfigured();
      request.log.info(
        {
          event: 'admin.password_reset_link_sent',
          caller_id: request.user!.id,
          target_id: target.id,
          target_email: target.email,
          org_id: request.user!.org_id,
          email_sent,
          smtp_configured: smtpReady,
          ttl_minutes: ttlMinutes,
        },
        'Admin sent a password-reset link',
      );

      return reply.send({
        data: {
          user_id: target.id,
          email: target.email,
          email_sent,
          smtp_configured: smtpReady,
          expires_in_minutes: ttlMinutes,
          message: email_sent
            ? 'Password reset link sent.'
            : 'Password reset token minted, but SMTP is not configured — the email was not delivered.',
        },
      });
    },
  );

  fastify.patch<{ Params: { userId: string } }>(
    '/org/members/:userId',
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member.update'), requireScope('admin')] },
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

  // ─── GET /org/members/:userId/deletion-eligibility ───────────────────
  // Probe-only — the People detail UI calls this to decide whether to
  // render the destructive "Delete account" button. Same eligibility
  // logic as the action endpoint below.
  fastify.get<{ Params: { userId: string } }>(
    '/org/members/:userId/deletion-eligibility',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      const result = await checkAdminDeletionEligibility(
        request.user!.id,
        request.user!.is_superuser,
        request.params.userId,
      );
      return reply.send({ data: result });
    },
  );

  // ─── POST /org/members/:userId/delete-account ────────────────────────
  // Cross-org account deletion by an admin. Caller must be admin in EVERY
  // org the target user is a member of (SuperUsers skip the check). The
  // user is soft-deleted: email tombstoned, password cleared, sessions
  // destroyed, API keys revoked, every org/project membership removed.
  // The users row stays in place so authored content (tasks, comments,
  // Banter messages, …) keeps a valid FK.
  fastify.post<{ Params: { userId: string }; Body: { reason?: string } }>(
    '/org/members/:userId/delete-account',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      const eligibility = await checkAdminDeletionEligibility(
        request.user!.id,
        request.user!.is_superuser,
        request.params.userId,
      );
      if (!eligibility.eligible) {
        return reply.status(eligibility.reason === 'target_not_found' ? 404 : 403).send({
          error: {
            code:
              eligibility.reason === 'self'
                ? 'CANNOT_DELETE_SELF'
                : eligibility.reason === 'is_superuser'
                  ? 'CANNOT_DELETE_SUPERUSER'
                  : eligibility.reason === 'target_not_found'
                    ? 'NOT_FOUND'
                    : 'NOT_ADMIN_EVERYWHERE',
            message:
              eligibility.reason === 'self'
                ? 'You cannot delete your own account through this endpoint'
                : eligibility.reason === 'is_superuser'
                  ? 'SuperUser accounts can only be deleted by another SuperUser'
                  : eligibility.reason === 'target_not_found'
                    ? 'User not found'
                    : 'You can only delete an account whose every org membership is one you manage',
            details:
              eligibility.reason === 'not_admin_everywhere'
                ? [
                    {
                      field: 'target_orgs',
                      issue: `target is in ${eligibility.target_orgs.length} org(s); you administer ${eligibility.caller_admin_orgs.length}`,
                    },
                  ]
                : [],
            request_id: request.id,
          },
        });
      }
      try {
        const result = await softDeleteUser({
          targetUserId: request.params.userId,
          actorUserId: request.user!.id,
          actorIsSuperuser: request.user!.is_superuser,
          reason:
            typeof request.body?.reason === 'string'
              ? request.body.reason.slice(0, 500)
              : undefined,
        });
        request.log.info(
          {
            event: 'org_admin.user_account_deleted',
            target_user_id: result.id,
            previous_email: result.previous_email,
          },
          'Org admin deleted a user account',
        );
        return reply.send({ data: { success: true, ...result } });
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        if (err instanceof CannotDeleteSelfError || err instanceof CannotDeleteSuperuserError) {
          return reply.status(403).send({
            error: {
              code: err.name === 'CannotDeleteSelfError' ? 'CANNOT_DELETE_SELF' : 'CANNOT_DELETE_SUPERUSER',
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

  fastify.delete<{ Params: { userId: string } }>(
    '/org/members/:userId',
    { preHandler: [requireAuth, fastify.requireCan('bam.org_member.delete'), requireScope('admin')] },
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
