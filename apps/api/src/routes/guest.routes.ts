import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { db } from '../db/index.js';
import { guestInvitations } from '../db/schema/guest-invitations.js';
import { users } from '../db/schema/users.js';
import { projectMemberships } from '../db/schema/project-memberships.js';
import { notifications } from '../db/schema/notifications.js';
import { organizations } from '../db/schema/organizations.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { setUserOrgRole } from '../services/role-resolver.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendGuestInvitationEmail, isSmtpConfigured } from '../lib/email-queue.js';
import { env } from '../env.js';

export default async function guestRoutes(fastify: FastifyInstance) {
  // ── POST /v1/guests/invite ─────────────────────────────────────────
  // Create a guest invitation (requires org admin/owner)
  fastify.post(
    '/v1/guests/invite',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.guest.invite'),
        requireScope('admin'),
      ],
    },
    async (request, reply) => {
      const schema = z.object({
        email: z.string().email().max(320),
        project_ids: z.array(z.string().uuid()).optional(),
        channel_ids: z.array(z.string()).optional(),
        expires_in_days: z.number().int().min(1).max(90).default(7),
      });
      const data = schema.parse(request.body);

      // (P1-31) Prevent scope-escalation via duplicate invitations: revoke any
      // existing pending invitations for the same (org_id, email) tuple by
      // expiring them immediately. This ensures only one pending invitation
      // with one scope exists at a time for a given email in an org.
      const revoked = await db
        .update(guestInvitations)
        .set({ expires_at: new Date() })
        .where(
          and(
            eq(guestInvitations.org_id, request.user!.org_id),
            eq(guestInvitations.email, data.email),
            isNull(guestInvitations.accepted_at),
            gt(guestInvitations.expires_at, new Date()),
          ),
        )
        .returning({ id: guestInvitations.id });

      if (revoked.length > 0) {
        request.log.warn(
          { org_id: request.user!.org_id, email: data.email, revoked_count: revoked.length },
          'Revoked existing pending guest invitation(s) before issuing new one (P1-31)',
        );
      }

      // Check if the email already belongs to a user in this org
      const [existingUser] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.org_id, request.user!.org_id),
            eq(users.email, data.email),
          ),
        )
        .limit(1);

      if (existingUser) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'A user with this email already exists in the organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      const token = randomBytes(48).toString('base64url');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + data.expires_in_days);

      const [invitation] = await db
        .insert(guestInvitations)
        .values({
          org_id: request.user!.org_id,
          invited_by: request.user!.id,
          email: data.email,
          role: 'guest',
          project_ids: data.project_ids ?? null,
          channel_ids: data.channel_ids ?? null,
          token,
          expires_at: expiresAt,
        })
        .returning();

      // (P1-30) Invitation tokens MUST be delivered to the invitee via email
      // only. We do not return the raw token in the admin API response —
      // exposing it would leak credentials into browser history, server
      // access logs, screenshots, or any downstream observability tooling.
      // The inviter sees only non-sensitive metadata + an `email_sent` flag.
      //
      // Resolve the inviter's display name + org name for the email body.
      const [inviter] = await db
        .select({ display_name: users.display_name })
        .from(users)
        .where(eq(users.id, request.user!.id))
        .limit(1);
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, request.user!.org_id))
        .limit(1);

      const smtpConfigured = await isSmtpConfigured();
      let emailSent = false;
      if (smtpConfigured) {
        emailSent = await sendGuestInvitationEmail({
          to: data.email,
          token,
          orgName: org?.name ?? 'BigBlueBam',
          inviterName: inviter?.display_name ?? 'A teammate',
        });
      } else {
        request.log.warn(
          { invitation_id: invitation!.id, email: data.email },
          'SMTP is not configured (neither system_settings nor env) — guest invitation email was NOT sent.',
        );
      }

      const responseData: Record<string, unknown> = {
        id: invitation!.id,
        email: invitation!.email,
        role: invitation!.role,
        expires_at: invitation!.expires_at,
        invited_at: invitation!.created_at,
        email_sent: emailSent,
      };

      // Dev-only: echo the token back for local testing convenience. Gated
      // on NODE_ENV !== 'production' so production responses never leak it.
      if (env.NODE_ENV !== 'production') {
        responseData.token = token;
        responseData.invite_url = `/guests/accept/${token}`;
      }

      return reply.status(201).send({ data: responseData });
    },
  );

  // ── GET /v1/guests/invitations ─────────────────────────────────────
  // List pending invitations for the org (requires org admin/owner)
  fastify.get(
    '/v1/guests/invitations',
    { preHandler: [requireAuth, fastify.requireCan('bam.guest_invitation.list'), requireScope('admin')] },
    async (request, reply) => {
      // (P1-30) Never return the raw invitation token in list responses —
      // tokens are bearer credentials and must only be delivered to the
      // invitee via the invitation email.
      const invitations = await db
        .select({
          id: guestInvitations.id,
          email: guestInvitations.email,
          project_ids: guestInvitations.project_ids,
          channel_ids: guestInvitations.channel_ids,
          invited_by: guestInvitations.invited_by,
          accepted_at: guestInvitations.accepted_at,
          expires_at: guestInvitations.expires_at,
          created_at: guestInvitations.created_at,
        })
        .from(guestInvitations)
        .where(eq(guestInvitations.org_id, request.user!.org_id))
        .orderBy(guestInvitations.created_at);

      return reply.send({ data: invitations });
    },
  );

  // ── DELETE /v1/guests/invitations/:id ──────────────────────────────
  // Revoke an invitation (requires org admin/owner)
  fastify.delete<{ Params: { id: string } }>(
    '/v1/guests/invitations/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.guest_invitation.delete'), requireScope('admin')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(guestInvitations)
        .where(
          and(
            eq(guestInvitations.id, request.params.id),
            eq(guestInvitations.org_id, request.user!.org_id),
          ),
        )
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Invitation not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  // ── POST /v1/guests/invitations/:id/resend ────────────────────────
  // Re-send the invitation email for an existing, still-valid invitation.
  // (P1-30 follow-up) Since the raw token is no longer returned in invite
  // responses, admins need a way to re-deliver the email without revoking +
  // recreating the invitation (which would rotate the token and invalidate
  // any link already delivered). This endpoint re-enqueues the email with
  // the SAME stored token — it never regenerates or exposes it.
  //
  // Rate-limited to 5/min per user: legitimate admin use is a handful of
  // resends per session, so a tight cap blunts abuse without hampering ops.
  fastify.post<{ Params: { id: string } }>(
    '/v1/guests/invitations/:id/resend',
    {
      preHandler: [requireAuth, fastify.requireCan('bam.guest_invitation_resend.create'), requireScope('admin')],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const [invitation] = await db
        .select()
        .from(guestInvitations)
        .where(eq(guestInvitations.id, request.params.id))
        .limit(1);

      if (!invitation) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Invitation not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Org-scoping: non-superusers can only resend invitations from their
      // own active org. SuperUsers may resend across orgs.
      if (!request.user!.is_superuser && invitation.org_id !== request.user!.org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Invitation not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // 410 GONE if the invitation is no longer actionable: accepted,
      // revoked, or expired. The invite-create path expires stale rows
      // in-place by setting expires_at=now(), so the expires_at check
      // covers the legacy "revoked" case as well.
      const now = new Date();
      if (
        invitation.accepted_at !== null ||
        invitation.revoked_at !== null ||
        invitation.expires_at <= now
      ) {
        return reply.status(410).send({
          error: {
            code: 'GONE',
            message: 'Invitation invalid, expired, revoked, or already accepted',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Resolve inviter display name + org name for the email body. We use
      // the invitation's org_id (not the requester's) so SuperUsers resending
      // cross-org get the correct org name in the email.
      const [inviter] = await db
        .select({ display_name: users.display_name })
        .from(users)
        .where(eq(users.id, invitation.invited_by))
        .limit(1);
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, invitation.org_id))
        .limit(1);

      const smtpConfigured = await isSmtpConfigured();
      let emailSent = false;
      if (smtpConfigured) {
        emailSent = await sendGuestInvitationEmail({
          to: invitation.email,
          token: invitation.token,
          orgName: org?.name ?? 'BigBlueBam',
          inviterName: inviter?.display_name ?? 'A teammate',
        });
      } else {
        request.log.warn(
          { invitation_id: invitation.id, email: invitation.email },
          'SMTP is not configured (neither system_settings nor env) — guest invitation email was NOT resent.',
        );
      }

      return reply.send({
        data: {
          id: invitation.id,
          email: invitation.email,
          email_sent: emailSent,
        },
      });
    },
  );

  // ── POST /v1/guests/accept/:token ─────────────────────────────────
  // Accept an invitation (no auth required — public endpoint)
  // (P1-29) Rate-limited to prevent brute-force token enumeration:
  // 5 attempts per 15 minutes per IP.
  fastify.post<{ Params: { token: string } }>(
    '/v1/guests/accept/:token',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
        },
      },
    },
    async (request, reply) => {
      const bodySchema = z.object({
        email: z.string().email().max(320),
        display_name: z.string().max(100),
        password: z.string().min(8).max(128),
      });
      const data = bodySchema.parse(request.body);

      // Peek at the invitation first to validate the submitted email matches.
      // (P0-12) This prevents an attacker with a stolen token from registering
      // under a different email.
      const [peek] = await db
        .select()
        .from(guestInvitations)
        .where(eq(guestInvitations.token, request.params.token))
        .limit(1);

      if (!peek) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Invitation not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (data.email.toLowerCase() !== peek.email.toLowerCase()) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Submitted email does not match the invitation',
            details: [{ field: 'email', issue: 'mismatch' }],
            request_id: request.id,
          },
        });
      }

      // Hash the password before entering the transaction (argon2 is slow).
      const argon2 = await import('argon2');
      const passwordHash = await argon2.hash(data.password);

      // (P0-15) Atomically claim the invitation + create the user +
      // insert project memberships in a single transaction. The atomic
      // UPDATE on accepted_at guarantees only one concurrent request wins
      // the race. If anything inside the transaction throws, the claim
      // rolls back automatically.
      try {
        const result = await db.transaction(async (tx) => {
          const claimedResult = await tx
            .update(guestInvitations)
            .set({ accepted_at: new Date() })
            .where(
              and(
                eq(guestInvitations.token, request.params.token),
                isNull(guestInvitations.accepted_at),
                gt(guestInvitations.expires_at, new Date()),
              ),
            )
            .returning();

          if (claimedResult.length === 0) {
            // Signal the caller to return 410.
            throw new Error('INVITATION_UNAVAILABLE');
          }

          const invitation = claimedResult[0]!;

          // Create the guest user account. Wave E.F: role lives in
          // account_group_memberships now, not on users or org_memberships.
          const [guestUser] = await tx
            .insert(users)
            .values({
              org_id: invitation.org_id,
              email: invitation.email,
              display_name: data.display_name,
              password_hash: passwordHash,
            })
            .returning();

          // Establish org membership + guest role via the per-action
          // permissions group system.
          await tx.insert(organizationMemberships).values({
            user_id: guestUser!.id,
            org_id: invitation.org_id,
            is_default: true,
          });
          await setUserOrgRole(guestUser!.id, invitation.org_id, 'guest', {}, tx);

          // Add the guest to specified projects as 'member' role
          if (invitation.project_ids && invitation.project_ids.length > 0) {
            const membershipValues = invitation.project_ids.map((projectId) => ({
              project_id: projectId,
              user_id: guestUser!.id,
              role: 'member',
            }));
            await tx.insert(projectMemberships).values(membershipValues);
          }

          return { invitation, guestUser: { ...guestUser!, role: 'guest' } };
        });

        // NOTE: Channel membership auto-add would go here once the Banter
        // channel_members schema is wired up. For now, channel_ids are stored
        // on the invitation for future use.

        return reply.status(201).send({
          data: {
            id: result.guestUser.id,
            email: result.guestUser.email,
            display_name: result.guestUser.display_name,
            role: result.guestUser.role,
            org_id: result.guestUser.org_id,
            project_ids: result.invitation.project_ids,
            channel_ids: result.invitation.channel_ids,
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'INVITATION_UNAVAILABLE') {
          return reply.status(410).send({
            error: {
              code: 'GONE',
              message: 'Invitation invalid, expired, or already accepted',
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // ── GET /v1/guests ─────────────────────────────────────────────────
  // List current guest users in the org (requires org admin/owner)
  fastify.get(
    '/v1/guests',
    { preHandler: [requireAuth, fastify.requireCan('bam.guest.list'), requireScope('admin')] },
    async (request, reply) => {
      // Wave E.F: "guest" is a value of permission_groups.legacy_role; we
      // filter via the user's org-scope group membership.
      const guests = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          role: permissionGroups.legacy_role,
          is_active: users.is_active,
          created_at: users.created_at,
          last_seen_at: users.last_seen_at,
        })
        .from(users)
        .innerJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.org_id, request.user!.org_id),
            eq(permissionGroups.legacy_role, 'guest'),
          ),
        )
        .orderBy(users.display_name);

      return reply.send({ data: guests.map((g) => ({ ...g, role: g.role ?? 'guest' })) });
    },
  );

  // ── PATCH /v1/guests/:id/scope ─────────────────────────────────────
  // Update a guest's project and channel access (requires org admin/owner)
  fastify.patch<{ Params: { id: string } }>(
    '/v1/guests/:id/scope',
    { preHandler: [requireAuth, fastify.requireCan('bam.guest_scope.update'), requireScope('admin')] },
    async (request, reply) => {
      const bodySchema = z.object({
        project_ids: z.array(z.string().uuid()).optional(),
        channel_ids: z.array(z.string()).optional(),
      });
      const data = bodySchema.parse(request.body);

      // Verify the user is a guest in this org. Wave E.F: filter by the
      // user's org-scope group membership's legacy_role.
      const [guestUserRow] = await db
        .select({
          user: users,
          legacy_role: permissionGroups.legacy_role,
        })
        .from(users)
        .innerJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.id, request.params.id),
            eq(users.org_id, request.user!.org_id),
            eq(permissionGroups.legacy_role, 'guest'),
          ),
        )
        .limit(1);

      const guestUser = guestUserRow
        ? { ...guestUserRow.user, role: guestUserRow.legacy_role ?? 'guest' }
        : undefined;

      if (!guestUser) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Guest user not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Update project memberships if project_ids provided
      if (data.project_ids !== undefined) {
        // Remove all existing project memberships for this guest
        await db
          .delete(projectMemberships)
          .where(eq(projectMemberships.user_id, guestUser.id));

        // Add new project memberships
        if (data.project_ids.length > 0) {
          const membershipValues = data.project_ids.map((projectId) => ({
            project_id: projectId,
            user_id: guestUser.id,
            role: 'member',
          }));
          await db.insert(projectMemberships).values(membershipValues);
        }
      }

      // Update the most recent accepted invitation's channel_ids if provided
      if (data.channel_ids !== undefined) {
        await db
          .update(guestInvitations)
          .set({ channel_ids: data.channel_ids })
          .where(
            and(
              eq(guestInvitations.org_id, request.user!.org_id),
              eq(guestInvitations.email, guestUser.email),
            ),
          );
      }

      // Fetch updated project memberships
      const updatedMemberships = await db
        .select({ project_id: projectMemberships.project_id })
        .from(projectMemberships)
        .where(eq(projectMemberships.user_id, guestUser.id));

      // (P2-14) Notify the guest that their scope has been updated.
      // The notifications table requires project_id (notNull), so we attach
      // the notification to one of the guest's current project memberships.
      // If the guest has no project memberships left, skip the notification.
      const notifyProjectId = updatedMemberships[0]?.project_id ?? null;
      if (notifyProjectId) {
        const [org] = await db
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, request.user!.org_id))
          .limit(1);
        const orgName = org?.name ?? 'the organization';
        await db.insert(notifications).values({
          user_id: guestUser.id,
          project_id: notifyProjectId,
          type: 'guest_scope_updated',
          title: 'Your access scope has been updated',
          body: `An admin updated your access scope in ${orgName}.`,
        });
      }

      return reply.send({
        data: {
          id: guestUser.id,
          email: guestUser.email,
          display_name: guestUser.display_name,
          role: guestUser.role,
          project_ids: updatedMemberships.map((m) => m.project_id),
          channel_ids: data.channel_ids,
        },
      });
    },
  );

  // ── DELETE /v1/guests/:id ──────────────────────────────────────────
  // Remove a guest from the org (deactivate) (requires org admin/owner)
  fastify.delete<{ Params: { id: string } }>(
    '/v1/guests/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.guest.delete'), requireScope('admin')] },
    async (request, reply) => {
      // Verify the user is a guest in this org. Wave E.F: filter via
      // account_group_memberships → permission_groups.legacy_role.
      const [guestUserRow] = await db
        .select({ user: users })
        .from(users)
        .innerJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .innerJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.id, request.params.id),
            eq(users.org_id, request.user!.org_id),
            eq(permissionGroups.legacy_role, 'guest'),
          ),
        )
        .limit(1);

      const guestUser = guestUserRow?.user;

      if (!guestUser) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Guest user not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // (P2-18) Atomically deactivate the guest and remove all project
      // memberships in a single transaction. If either step fails, neither
      // is persisted, preventing the guest from being left in a half-removed
      // state (e.g., still able to access projects but marked inactive, or
      // memberships wiped but account still active).
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ is_active: false, updated_at: new Date() })
          .where(eq(users.id, guestUser.id));

        await tx
          .delete(projectMemberships)
          .where(eq(projectMemberships.user_id, guestUser.id));
      });

      return reply.send({ data: { success: true } });
    },
  );
}
