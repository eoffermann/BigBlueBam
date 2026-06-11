import type { FastifyInstance } from 'fastify';
import { registerSchema, bootstrapSchema, loginSchema, updateProfileSchema } from '@bigbluebam/shared';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import * as authService from '../services/auth.service.js';
import * as orgService from '../services/org.service.js';
import * as passwordResetService from '../services/password-reset.service.js';
import { sendPasswordResetEmail, isSmtpConfigured } from '../lib/email-queue.js';
import { computePermissionMatrix } from '../services/permissions.service.js';
import { requireAuth } from '../plugins/auth.js';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { organizations } from '../db/schema/organizations.js';
import { users } from '../db/schema/users.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { resolveUserOrgRole } from '../services/role-resolver.js';
import { loginHistory } from '../db/schema/login-history.js';
import type { LoginFailureReason } from '../services/auth.service.js';
import {
  checkLockout,
  recordFailure,
  clearLockout,
  LOCKOUT_MESSAGE,
} from '../lib/login-lockout.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { isPublicSignupDisabled } from '../services/platform-settings.service.js';
import { invalidateBootstrapRequiredCache } from '../services/bootstrap-status.service.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';

export default async function authRoutes(fastify: FastifyInstance) {
  const cookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: env.SESSION_TTL_SECONDS,
  };

  function truncateUA(ua: unknown): string | null {
    if (typeof ua !== 'string' || ua.length === 0) return null;
    return ua.length > 512 ? ua.slice(0, 512) : ua;
  }

  async function recordLoginAttempt(args: {
    userId: string | null;
    email: string;
    ipAddress: string | null;
    userAgent: string | null;
    success: boolean;
    failureReason: LoginFailureReason | null;
  }) {
    try {
      await db.insert(loginHistory).values({
        user_id: args.userId,
        email: args.email,
        ip_address: args.ipAddress,
        user_agent: args.userAgent,
        success: args.success,
        failure_reason: args.failureReason,
      });
    } catch (err) {
      fastify.log.warn({ err }, 'Failed to record login_history entry');
    }
  }

  fastify.post('/auth/bootstrap', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '5 minutes',
        keyGenerator: (req) => req.ip,
      },
    },
  }, async (request, reply) => {
    const data = bootstrapSchema.parse(request.body);
    const ipAddress = request.ip;
    const userAgent = truncateUA(request.headers['user-agent']);

    try {
      const result = await authService.bootstrap(data, { ipAddress, userAgent });

      invalidateBootstrapRequiredCache();

      reply.setCookie('session', result.session.id, cookieOptions);
      issueCsrfToken(reply);

      await recordLoginAttempt({
        userId: result.user.id,
        email: data.email.toLowerCase(),
        ipAddress,
        userAgent,
        success: true,
        failureReason: null,
      });

      await logSuperuserAction({
        superuserId: result.user.id,
        action: 'bootstrap_create',
        targetType: 'user',
        targetId: result.user.id,
        details: {
          org_id: result.org.id,
          org_slug: result.org.slug,
        },
        ipAddress,
        userAgent: userAgent ?? undefined,
      });

      return reply.status(201).send({
        data: {
          user: {
            id: result.user.id,
            email: result.user.email,
            display_name: result.user.display_name,
            // Bootstrap mints the first SuperUser as the owner of the new org.
            role: 'owner',
            org_id: result.user.org_id,
            is_superuser: result.user.is_superuser,
            active_org_id: result.user.org_id,
          },
          organization: {
            id: result.org.id,
            name: result.org.name,
            slug: result.org.slug,
          },
        },
      });
    } catch (err) {
      if (err instanceof authService.BootstrapAlreadyCompleteError) {
        return reply.status(409).send({
          error: {
            code: 'ALREADY_BOOTSTRAPPED',
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });

  fastify.post('/auth/register', async (request, reply) => {
    // Platform-wide kill switch: SuperUsers can freeze public signup from
    // the superuser panel. Existing accounts continue to function; only
    // new-account creation is rejected.
    if (await isPublicSignupDisabled()) {
      return reply.status(403).send({
        error: {
          code: 'SIGNUP_DISABLED',
          message: 'Public signup is currently closed. Join the notify list to be invited.',
          request_id: request.id,
        },
      });
    }
    const data = registerSchema.parse(request.body);
    const ipAddress = request.ip;
    const userAgent = truncateUA(request.headers['user-agent']);
    const result = await authService.register(data, { ipAddress, userAgent });

    reply.setCookie('session', result.session.id, cookieOptions);
    issueCsrfToken(reply);

    await recordLoginAttempt({
      userId: result.user.id,
      email: data.email.toLowerCase(),
      ipAddress,
      userAgent,
      success: true,
      failureReason: null,
    });

    return reply.status(201).send({
      data: {
        user: {
          id: result.user.id,
          email: result.user.email,
          display_name: result.user.display_name,
          // Register mints the new account as owner of the new org.
          role: 'owner',
          org_id: result.user.org_id,
          is_superuser: result.user.is_superuser,
          active_org_id: result.user.org_id,
        },
        organization: {
          id: result.org.id,
          name: result.org.name,
          slug: result.org.slug,
        },
      },
    });
  });

  fastify.post('/auth/login', async (request, reply) => {
    const data = loginSchema.parse(request.body);
    const ipAddress = request.ip;
    const userAgent = truncateUA(request.headers['user-agent']);
    const emailLower = data.email.toLowerCase();

    // HB-57: short-circuit on lockout BEFORE any DB lookup or argon2.verify
    // so brute-force attackers can't burn CPU.
    if (await checkLockout(fastify.redis, data.email)) {
      await recordLoginAttempt({
        userId: null,
        email: emailLower,
        ipAddress,
        userAgent,
        success: false,
        failureReason: 'account_locked',
      });
      return reply.status(429).send({
        error: {
          code: 'ACCOUNT_LOCKED',
          message: LOCKOUT_MESSAGE,
          details: [],
          request_id: request.id,
        },
      });
    }

    try {
      const result = await authService.login(
        data.email,
        data.password,
        data.totp_code,
        { ipAddress, userAgent },
      );

      // Successful login — clear any accumulated failure counter.
      await clearLockout(fastify.redis, data.email);

      reply.setCookie('session', result.session.id, cookieOptions);
      issueCsrfToken(reply);

      await recordLoginAttempt({
        userId: result.user.id,
        email: emailLower,
        ipAddress,
        userAgent,
        success: true,
        failureReason: null,
      });

      // Wave E.F: role is resolved from the user's home-org group membership.
      const loginRole = (await resolveUserOrgRole(result.user.id, result.user.org_id)) ?? 'member';

      return reply.send({
        data: {
          user: {
            id: result.user.id,
            email: result.user.email,
            display_name: result.user.display_name,
            role: loginRole,
            org_id: result.user.org_id,
            is_superuser: result.user.is_superuser,
            active_org_id: result.user.org_id,
          },
        },
      });
    } catch (err) {
      if (err instanceof authService.AuthError) {
        // HB-57: Count any auth failure (bad password, unknown user, disabled
        // account) against the lockout counter. The service's existing
        // timing-safe handling of unknown users stays intact because we
        // already called into it above.
        if (err.code === 'INVALID_CREDENTIALS') {
          await recordFailure(fastify.redis, data.email);
        }
        // Look up the user_id when we have a known user (invalid password /
        // disabled / unverified) so the history row is attributable. For
        // user_not_found we leave user_id null.
        let loggedUserId: string | null = null;
        if (err.failureReason && err.failureReason !== 'user_not_found') {
          try {
            const [u] = await db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.email, data.email))
              .limit(1);
            loggedUserId = u?.id ?? null;
          } catch {
            // non-fatal
          }
        }
        await recordLoginAttempt({
          userId: loggedUserId,
          email: emailLower,
          ipAddress,
          userAgent,
          success: false,
          failureReason: err.failureReason ?? 'invalid_password',
        });
        return reply.status(err.statusCode).send({
          error: {
            code: err.code,
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });

  fastify.post('/auth/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    if (request.sessionId) {
      await authService.logout(request.sessionId);
    }

    reply.clearCookie('session', { path: '/' });
    reply.clearCookie('csrf_token', { path: '/' });

    return reply.send({ data: { success: true } });
  });

  fastify.get('/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await authService.getUserById(request.user!.id);
    if (!user) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'User not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Wave E.C: materialize the full per-action permission matrix and
    // ship it alongside the user payload so the frontend `useCan` hook
    // can answer "may I show this button?" without a per-call RPC.
    // Resolver runs over the cached PermissionContext; matrix itself is
    // cached at `perms:matrix:<user_id>:<org_id>` with the same 5-min TTL
    // and the same invalidation listener that clears the context cache.
    // Failures here are non-fatal — the hook deny-by-defaults until it
    // has a matrix, but the rest of /auth/me must not be blocked.
    let permissions: Record<string, boolean> = {};
    try {
      const matrix = await computePermissionMatrix(request);
      if (matrix) permissions = matrix;
    } catch (err) {
      request.log.warn(
        { err, user_id: request.user!.id },
        'computePermissionMatrix failed; serving /auth/me without permissions',
      );
    }

    return reply.send({
      data: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        // Resolved per-request role for the user's CURRENT active org (not
        // the legacy users.role which tracks the home org only). For
        // multi-org users this is the membership role in whichever org
        // they've switched into.
        role: request.user!.role,
        org_id: request.user!.org_id,
        active_org_id: request.user!.active_org_id,
        is_superuser: user.is_superuser,
        // Actor kind (users.kind — migration 0127 / AGENTIC_TODO §10). Present
        // so callers like the MCP PolicyGate don't need a second round-trip to
        // /users/:id to decide "is this a human (skip policy check) or an
        // agent/service (run policy check)". A stale api image that didn't
        // return this field silently failed the gate as AGENT_DISABLED for
        // human callers; keeping it on /auth/me is load-bearing.
        kind: user.kind,
        // True when the user is a SuperUser viewing an org they are NOT a
        // native member of (via sessions.active_org_id). Used by the UI
        // to label confirm dialogs ("you will not be demoted") and show
        // the cross-org banner.
        is_superuser_viewing: request.user!.is_superuser_viewing,
        timezone: user.timezone,
        notification_prefs: user.notification_prefs,
        force_password_change: user.force_password_change,
        created_at: user.created_at.toISOString(),
        // Wave E.C: per-action permission matrix consumed by the
        // `useCan` hook in @bigbluebam/ui/use-can. Empty `{}` when the
        // resolver couldn't load (deny-by-default on the client).
        permissions,
      },
    });
  });

  fastify.get('/auth/orgs', { preHandler: [requireAuth] }, async (request, reply) => {
    const userId = request.user!.id;

    // Wave E.F: role resolved via account_group_memberships → permission_groups.
    const memberships = await db
      .select({
        org_id: organizationMemberships.org_id,
        role: permissionGroups.legacy_role,
        is_default: organizationMemberships.is_default,
        joined_at: organizationMemberships.joined_at,
        org_name: organizations.name,
        org_slug: organizations.slug,
        org_logo_url: organizations.logo_url,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizationMemberships.org_id, organizations.id))
      .leftJoin(
        accountGroupMemberships,
        and(
          eq(accountGroupMemberships.user_id, organizationMemberships.user_id),
          eq(accountGroupMemberships.scope_type, 'org'),
          eq(accountGroupMemberships.scope_id, organizationMemberships.org_id),
        ),
      )
      .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
      .where(eq(organizationMemberships.user_id, userId));

    return reply.send({
      data: {
        active_org_id: request.user!.active_org_id,
        organizations: memberships.map((m) => ({
          org_id: m.org_id,
          name: m.org_name,
          slug: m.org_slug,
          logo_url: m.org_logo_url,
          role: m.role ?? 'member',
          is_default: m.is_default,
          joined_at: m.joined_at.toISOString(),
        })),
      },
    });
  });

  fastify.post('/auth/switch-org', {
    preHandler: [requireAuth],
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.user?.id ?? req.ip,
      },
    },
  }, async (request, reply) => {
    const bodySchema = z.object({ org_id: z.string().uuid() });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
          request_id: request.id,
        },
      });
    }

    const { org_id } = parsed.data;
    const userId = request.user!.id;

    // Verify the user is a member of the requested org. Wave E.F: role
    // is resolved via account_group_memberships → permission_groups.
    const [membership] = await db
      .select({
        org_id: organizationMemberships.org_id,
        role: permissionGroups.legacy_role,
        is_default: organizationMemberships.is_default,
        org_name: organizations.name,
        org_slug: organizations.slug,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizationMemberships.org_id, organizations.id))
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
          eq(organizationMemberships.org_id, org_id),
        ),
      )
      .limit(1);

    if (!membership) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'You are not a member of that organization',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Rotate the session: delete the old one and issue a new session ID.
    // This mitigates session fixation risks across org context changes.
    if (request.sessionId) {
      await authService.logout(request.sessionId);
    }
    const newSession = await authService.createSession(userId, {
      ipAddress: request.ip,
      userAgent: truncateUA(request.headers['user-agent']),
    });
    // Persist the chosen org on the new session so the auth plugin uses it
    // on subsequent requests. Without this the new session's active_org_id
    // is NULL and every request falls back to the user's default membership,
    // making the switch appear to have no effect.
    await authService.setSessionActiveOrgId(newSession.id, membership.org_id);
    reply.setCookie('session', newSession.id, cookieOptions);
    issueCsrfToken(reply);

    return reply.send({
      data: {
        active_org_id: membership.org_id,
        organization: {
          id: membership.org_id,
          name: membership.org_name,
          slug: membership.org_slug,
        },
        role: membership.role ?? 'member',
        is_default: membership.is_default,
        cache_bust: Date.now().toString(),
      },
    });
  });

  fastify.post('/auth/change-password', {
    preHandler: [requireAuth],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (req) => req.user?.id ?? req.ip,
      },
    },
  }, async (request, reply) => {
    const schema = z.object({
      current_password: z.string().min(1).max(200),
      new_password: z.string().min(12).max(200),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
          request_id: request.id,
        },
      });
    }

    try {
      await orgService.changeOwnPassword({
        userId: request.user!.id,
        currentPassword: parsed.data.current_password,
        newPassword: parsed.data.new_password,
        currentSessionId: request.sessionId ?? null,
      });
      request.log.info(
        {
          event: 'auth.password_changed',
          user_id: request.user!.id,
        },
        'User changed own password',
      );
      return reply.send({ data: { success: true } });
    } catch (err) {
      if (err instanceof orgService.InvalidCurrentPasswordError) {
        return reply.status(401).send({
          error: {
            code: 'INVALID_CREDENTIALS',
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });

  // ─── Public password-reset link flow (B3 Frndo Launch) ─────────────────
  //
  // Two endpoints:
  //   POST /auth/password-reset/request   → email a reset link (self-serve)
  //   POST /auth/password-reset/consume   → consume the link + set new pw
  //
  // The request endpoint is deliberately opaque: it returns 200 in every
  // case (even for unknown emails) so an attacker can't enumerate accounts.
  // It rate-limits per IP. The consume endpoint validates the token and
  // returns a stable error code (INVALID_TOKEN/EXPIRED/ALREADY_USED) so
  // the UI can show a useful message.

  fastify.post('/auth/password-reset/request', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '5 minutes',
        keyGenerator: (req) => req.ip,
      },
    },
  }, async (request, reply) => {
    const schema = z.object({ email: z.string().email().max(320) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
          request_id: request.id,
        },
      });
    }

    const normalized = parsed.data.email.toLowerCase().trim();
    const [user] = await db
      .select({ id: users.id, email: users.email, display_name: users.display_name })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    // Opaque success: don't tell the caller whether the email exists.
    if (user) {
      const minted = await passwordResetService.mintToken({
        userId: user.id,
        createdBy: null,
        ipAddress: request.ip,
        purpose: 'reset',
      });
      const ttlMinutes = Math.max(
        1,
        Math.round((minted.expiresAt.getTime() - Date.now()) / 60_000),
      );
      try {
        await sendPasswordResetEmail({
          to: user.email,
          token: minted.token,
          userName: user.display_name || user.email,
          expiresInMinutes: ttlMinutes,
        });
      } catch (err) {
        request.log.error({ err, target_email: user.email }, 'forgot-password email enqueue threw');
      }
      request.log.info(
        { event: 'auth.password_reset_requested', user_id: user.id },
        'Password-reset link requested',
      );
    } else {
      request.log.info(
        { event: 'auth.password_reset_requested_unknown', email: normalized },
        'Password-reset requested for unknown email',
      );
    }

    return reply.send({
      data: {
        success: true,
        message:
          'If an account exists with that email, a password-reset link has been sent.',
        smtp_configured: await isSmtpConfigured(),
      },
    });
  });

  fastify.post('/auth/password-reset/consume', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '5 minutes',
        keyGenerator: (req) => req.ip,
      },
    },
  }, async (request, reply) => {
    const schema = z.object({
      token: z.string().min(20).max(200),
      new_password: z.string().min(12).max(200),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
          request_id: request.id,
        },
      });
    }

    try {
      const result = await passwordResetService.consumeToken({
        token: parsed.data.token,
        newPassword: parsed.data.new_password,
      });
      request.log.info(
        {
          event: 'auth.password_reset_consumed',
          user_id: result.userId,
          purpose: result.purpose,
        },
        'Password reset link consumed',
      );
      return reply.send({
        data: {
          success: true,
          purpose: result.purpose,
          email: result.email,
          message:
            result.purpose === 'invite'
              ? 'Your password is set. You can now log in.'
              : 'Your password has been reset. You can now log in.',
        },
      });
    } catch (err) {
      if (err instanceof passwordResetService.PasswordResetTokenInvalidError) {
        return reply.status(400).send({
          error: {
            code: err.code,
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      if (err instanceof passwordResetService.PasswordResetUserMissingError) {
        return reply.status(410).send({
          error: {
            code: 'GONE',
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });

  fastify.patch('/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const data = updateProfileSchema.parse(request.body);
    const user = await authService.updateProfile(request.user!.id, data);

    if (!user) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'User not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    return reply.send({
      data: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        timezone: user.timezone,
        notification_prefs: user.notification_prefs,
      },
    });
  });
}
