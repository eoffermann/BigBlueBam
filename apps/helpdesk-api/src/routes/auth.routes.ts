import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import argon2 from 'argon2';
import { nanoid } from 'nanoid';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { helpdeskUsers } from '../db/schema/helpdesk-users.js';
import { helpdeskSessions } from '../db/schema/helpdesk-sessions.js';
import { helpdeskSettings } from '../db/schema/helpdesk-settings.js';
import { requireHelpdeskAuth } from '../plugins/auth.js';

/**
 * G7 / HB-44: hash email verification tokens with SHA-256 so an attacker who
 * exfiltrates the DB cannot present a plaintext token to verify-email. The
 * hex encoding is 64 chars, matching the helpdesk_users.email_verification_token_hash
 * column width from migration 0113.
 */
function hashEmailVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
import { env } from '../env.js';
import {
  checkLockout,
  recordFailure,
  clearLockout,
  LOCKOUT_MESSAGE,
} from '../lib/login-lockout.js';
import { issueCsrfToken } from '../plugins/csrf.js';

const registerSchema = z.object({
  email: z.string().email().max(320),
  display_name: z.string().min(1).max(100),
  password: z.string().min(12).max(256),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

// HB-17: Toggle to enforce email verification at login.
// Default false for dev; production deployments should set
// REQUIRE_EMAIL_VERIFICATION=true so unverified helpdesk users cannot log in
// (only takes effect when helpdesk_settings.require_email_verification is also true).
const REQUIRE_EMAIL_VERIFICATION =
  (process.env.REQUIRE_EMAIL_VERIFICATION ?? 'false').toLowerCase() === 'true';

// Precomputed dummy Argon2id hash used to equalize wall-clock time on login
// when the email does not correspond to a real helpdesk user. Prevents
// timing-based email enumeration. Lazily initialized once per process.
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(nanoid(32));
  }
  return dummyHashPromise;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // Expose Helpdesk's own signup flag to the helpdesk login page so the
  // "Create one" link can route to the beta-gate when signup is off.
  //
  // Important: Helpdesk reads `helpdesk_signup_disabled`, NOT
  // `public_signup_disabled`. Those gates are intentionally decoupled
  // (migration 0172) — closing BigBlueBam's internal signup during beta
  // should not also lock end-customers out of filing tickets.
  // The `public_signup_disabled` field is echoed back too so existing
  // consumers that may still read it don't get a sudden undefined.
  fastify.get('/helpdesk/public/config', async () => {
    const res = await db.execute(
      sql`SELECT public_signup_disabled, helpdesk_signup_disabled
            FROM platform_settings WHERE id = 1`,
    );
    // postgres-js returns the rows array directly; node-pg returns {rows: [...]}.
    // The register endpoint below already handled both shapes; this endpoint
    // used to assume only the node-pg shape and silently returned false for
    // the disabled flag on postgres-js stacks.
    type Row = {
      public_signup_disabled: boolean;
      helpdesk_signup_disabled: boolean;
    };
    const row: Row | undefined = Array.isArray(res)
      ? (res[0] as Row | undefined)
      : ((res as unknown as { rows?: Row[] }).rows?.[0]);
    return {
      data: {
        // Echoed for back-compat; helpdesk clients should NOT use this to
        // decide whether helpdesk signup is open.
        public_signup_disabled: row?.public_signup_disabled === true,
        // The flag helpdesk clients SHOULD read.
        helpdesk_signup_disabled: row?.helpdesk_signup_disabled === true,
      },
    };
  });
  const cookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: env.SESSION_TTL_SECONDS,
  };

  async function createSession(userId: string): Promise<string> {
    const sessionId = nanoid(48);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);

    await db.insert(helpdeskSessions).values({
      id: sessionId,
      user_id: userId,
      expires_at: expiresAt,
    });

    return sessionId;
  }

  // POST /helpdesk/auth/register
  // HB-33: 3 attempts per 15 minutes per IP to throttle abuse.
  fastify.post('/helpdesk/auth/register', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: 15 * 60 * 1000,
      },
    },
  }, async (request, reply) => {
    // Helpdesk's own kill switch (migration 0172). Decoupled from Bam's
    // `public_signup_disabled` so a SuperUser closing internal signup
    // during beta doesn't simultaneously block end-customers from filing
    // tickets. The two systems are distinct identity scopes.
    const flagResult = await db.execute(
      sql`SELECT helpdesk_signup_disabled FROM platform_settings WHERE id = 1`,
    );
    // postgres-js returns the rows array directly; node-pg returns {rows: [...]}.
    const row = Array.isArray(flagResult)
      ? (flagResult[0] as { helpdesk_signup_disabled: boolean } | undefined)
      : ((flagResult as unknown as { rows?: Array<{ helpdesk_signup_disabled: boolean }> }).rows?.[0]);
    if (row?.helpdesk_signup_disabled === true) {
      return reply.status(403).send({
        error: {
          code: 'SIGNUP_DISABLED',
          message: 'Helpdesk signup is currently closed. Contact your administrator.',
          request_id: request.id,
        },
      });
    }

    const data = registerSchema.parse(request.body);

    // D-010: Resolve helpdesk_settings from the X-Org-Slug header (set by
    // the SPA from the URL path), not `LIMIT 1`. Registrations that arrive
    // with no org context fall back to the legacy "first settings row"
    // behavior so direct API clients built before path-based routing
    // continue to work; the SPA will always supply the header.
    let orgSettings: typeof helpdeskSettings.$inferSelect | undefined;
    let registrationOrgId: string | null = null;

    if (request.tenantContext.orgId) {
      const rows = await db
        .select()
        .from(helpdeskSettings)
        .where(eq(helpdeskSettings.org_id, request.tenantContext.orgId))
        .limit(1);
      orgSettings = rows[0];
      registrationOrgId = request.tenantContext.orgId;
    } else {
      const rows = await db
        .select()
        .from(helpdeskSettings)
        .limit(1);
      orgSettings = rows[0];
      registrationOrgId = orgSettings?.org_id ?? null;
    }

    // G2: scope the existing-email check by org_id so the same customer
    // email can legitimately register under a different BBB org. Migration
    // 0110 already enforces UNIQUE (org_id, email) at the DB level; this
    // just gives us a friendlier 409 before the insert attempts.
    const existing = await db
      .select({ id: helpdeskUsers.id })
      .from(helpdeskUsers)
      .where(
        registrationOrgId
          ? and(
              eq(helpdeskUsers.email, data.email.toLowerCase()),
              eq(helpdeskUsers.org_id, registrationOrgId),
            )
          : eq(helpdeskUsers.email, data.email.toLowerCase()),
      )
      .limit(1);

    if (existing.length > 0) {
      return reply.status(409).send({
        error: {
          code: 'EMAIL_TAKEN',
          message: 'An account with this email already exists',
          details: [],
          request_id: request.id,
        },
      });
    }
    if (orgSettings && orgSettings.allowed_email_domains.length > 0) {
      const emailDomain = data.email.split('@')[1]?.toLowerCase();
      const allowed = orgSettings.allowed_email_domains.map((d) => d.toLowerCase());
      if (emailDomain && !allowed.includes(emailDomain)) {
        return reply.status(403).send({
          error: {
            code: 'DOMAIN_NOT_ALLOWED',
            message: 'Registration is restricted to approved email domains',
            details: [],
            request_id: request.id,
          },
        });
      }
    }

    const passwordHash = await argon2.hash(data.password);

    // G7 / HB-44: generate the plaintext token, hash it with SHA-256 for
    // storage, and keep the plaintext in a local only long enough to email
    // the customer (email send is a future wave; the route used to leave
    // the plaintext in the DB). Plaintext never touches helpdesk_users.
    let emailVerificationTokenHash: string | null = null;
    let emailVerificationSentAt: Date | null = null;

    if (orgSettings?.require_email_verification) {
      const plaintextToken = nanoid(64);
      emailVerificationTokenHash = hashEmailVerificationToken(plaintextToken);
      emailVerificationSentAt = new Date();
      // TODO: Queue verification email via BullMQ using `plaintextToken`
      // (never persist it). Wave 3 scope.
    }

    const [user] = await db
      .insert(helpdeskUsers)
      .values({
        // G2: tenant the new row. org_id may be NULL on bootstrap stacks
        // with no helpdesk_settings row; steady-state this is always set.
        org_id: registrationOrgId,
        email: data.email.toLowerCase(),
        display_name: data.display_name,
        password_hash: passwordHash,
        email_verified: !orgSettings?.require_email_verification,
        // G7: store the hash only. The legacy plaintext column stays NULL
        // so existing helpdesk_users rows with a plaintext token keep
        // working via the verify-email fallback below.
        email_verification_token: null,
        email_verification_token_hash: emailVerificationTokenHash,
        email_verification_sent_at: emailVerificationSentAt,
      })
      .returning();

    if (!user) {
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to create user',
          details: [],
          request_id: request.id,
        },
      });
    }

    const sessionId = await createSession(user.id);
    reply.setCookie('helpdesk_session', sessionId, cookieOptions);
    issueCsrfToken(reply);

    return reply.status(201).send({
      data: {
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          email_verified: user.email_verified,
        },
      },
    });
  });

  // POST /helpdesk/auth/login
  // HB-33: 5 attempts per 15 minutes per IP to slow brute-force guessing.
  // TODO: record helpdesk login attempts to a `helpdesk_login_history` table
  // once that schema exists. The Bam `login_history` table cannot be used
  // here because its user_id FK points at `users`, not `helpdesk_users`.
  fastify.post('/helpdesk/auth/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: 15 * 60 * 1000,
      },
    },
  }, async (request, reply) => {
    const data = loginSchema.parse(request.body);

    // HB-57: short-circuit on lockout BEFORE any DB lookup or argon2.verify.
    if (await checkLockout(fastify.redis, data.email)) {
      return reply.status(429).send({
        error: {
          code: 'ACCOUNT_LOCKED',
          message: LOCKOUT_MESSAGE,
          details: [],
          request_id: request.id,
        },
      });
    }

    // D-010: resolve the host org from X-Org-Slug (SPA-set) first; fall
    // back to "first settings row" only when no tenant header is present
    // so direct API clients continue working during rollout. When the
    // header is present, the resolved orgId is authoritative and a
    // same-email account under a different org cannot be logged into.
    let loginOrgId: string | null = null;
    if (request.tenantContext.orgId) {
      loginOrgId = request.tenantContext.orgId;
    } else {
      const [loginOrgSettings] = await db
        .select({ org_id: helpdeskSettings.org_id })
        .from(helpdeskSettings)
        .limit(1);
      loginOrgId = loginOrgSettings?.org_id ?? null;
    }

    const [user] = await db
      .select()
      .from(helpdeskUsers)
      .where(
        loginOrgId
          ? and(
              eq(helpdeskUsers.email, data.email.toLowerCase()),
              eq(helpdeskUsers.org_id, loginOrgId),
            )
          : eq(helpdeskUsers.email, data.email.toLowerCase()),
      )
      .limit(1);

    if (!user) {
      // Burn the same amount of CPU as a real argon2.verify() would, so that
      // response time cannot be used to distinguish "user does not exist" from
      // "user exists but password is wrong" (email enumeration defense).
      const dummyHash = await getDummyPasswordHash();
      await argon2.verify(dummyHash, data.password);
      await recordFailure(fastify.redis, data.email);
      return reply.status(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (!user.is_active) {
      return reply.status(403).send({
        error: {
          code: 'ACCOUNT_DISABLED',
          message: 'Your account has been disabled',
          details: [],
          request_id: request.id,
        },
      });
    }

    const valid = await argon2.verify(user.password_hash, data.password);
    if (!valid) {
      await recordFailure(fastify.redis, data.email);
      return reply.status(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Successful credential verification — clear the failure counter.
    await clearLockout(fastify.redis, data.email);

    // HB-17: Enforce email verification at login when both the env-level switch
    // and the org-level setting are enabled. We leave signup/verify-email flows
    // alone; email sending remains a TODO tracked with the notification queue.
    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      const [loginSettings] = await db
        .select({ require_email_verification: helpdeskSettings.require_email_verification })
        .from(helpdeskSettings)
        .limit(1);

      if (loginSettings?.require_email_verification) {
        return reply.status(403).send({
          error: {
            code: 'EMAIL_NOT_VERIFIED',
            message: 'Please verify your email before logging in.',
            details: [],
            request_id: request.id,
          },
        });
      }
    }

    const sessionId = await createSession(user.id);
    reply.setCookie('helpdesk_session', sessionId, cookieOptions);
    issueCsrfToken(reply);

    return reply.send({
      data: {
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          email_verified: user.email_verified,
        },
      },
    });
  });

  // POST /helpdesk/auth/logout
  fastify.post('/helpdesk/auth/logout', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    if (request.helpdeskSessionId) {
      await db
        .delete(helpdeskSessions)
        .where(eq(helpdeskSessions.id, request.helpdeskSessionId));
    }

    reply.clearCookie('helpdesk_session', { path: '/' });
    reply.clearCookie('csrf_token', { path: '/' });

    return reply.send({ data: { success: true } });
  });

  // GET /helpdesk/auth/me
  fastify.get('/helpdesk/auth/me', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;

    return reply.send({
      data: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        email_verified: user.email_verified,
      },
    });
  });

  // POST /helpdesk/auth/verify-email
  fastify.post('/helpdesk/auth/verify-email', async (request, reply) => {
    const { token } = verifyEmailSchema.parse(request.body);

    // G7 / HB-44: look the user up by hashed token first (what new
    // registrations write). Fall back to the legacy plaintext column for
    // in-flight registrations created before 0113 landed; those tokens
    // expire naturally within 24 hours per the existing check below.
    const hashed = hashEmailVerificationToken(token);
    let [user] = await db
      .select()
      .from(helpdeskUsers)
      .where(eq(helpdeskUsers.email_verification_token_hash, hashed))
      .limit(1);

    if (!user) {
      const fallback = await db
        .select()
        .from(helpdeskUsers)
        .where(eq(helpdeskUsers.email_verification_token, token))
        .limit(1);
      user = fallback[0];
    }

    if (!user) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired verification token',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Check if token is expired (24 hours)
    if (user.email_verification_sent_at) {
      const tokenAge = Date.now() - new Date(user.email_verification_sent_at).getTime();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      if (tokenAge > maxAge) {
        return reply.status(400).send({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Verification token has expired',
            details: [],
            request_id: request.id,
          },
        });
      }
    }

    await db
      .update(helpdeskUsers)
      .set({
        email_verified: true,
        email_verification_token: null,
        email_verification_token_hash: null,
        email_verification_sent_at: null,
      })
      .where(eq(helpdeskUsers.id, user.id));

    return reply.send({
      data: { success: true },
    });
  });
}
