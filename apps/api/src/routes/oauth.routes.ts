import type { FastifyInstance } from 'fastify';
import oauth2, { type OAuth2Namespace } from '@fastify/oauth2';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { organizations } from '../db/schema/organizations.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { createSession } from '../services/auth.service.js';
import { issueCsrfToken } from '../plugins/csrf.js';
import { env } from '../env.js';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Wave 1 / Platform §3.12 — OAuth route handlers.
 *
 * Two providers: GitHub and Google. Each registers an @fastify/oauth2
 * namespace which handles the PKCE + state dance automatically. The
 * callback path:
 *
 *   1. Exchange the authorization code for an access token (handled
 *      for us by the oauth2 plugin).
 *   2. Fetch the user profile from the provider.
 *   3. Upsert a users row by email. New users get a freshly created
 *      solo organization and an 'owner' membership, mirroring the
 *      password register flow in auth.service.ts.
 *   4. Create a session row and set the session cookie using the
 *      same options as /auth/login.
 *   5. Redirect to /b3/?oauth=complete.
 *
 * Microsoft OAuth is out of scope (Platform_Plan.md line 619).
 */

declare module 'fastify' {
  interface FastifyInstance {
    githubOAuth2?: OAuth2Namespace;
    googleOAuth2?: OAuth2Namespace;
  }
}

interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GoogleProfile {
  sub: string;
  name?: string;
  email?: string;
  email_verified?: boolean;
  picture?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'workspace';
}

async function fetchGithubProfile(accessToken: string): Promise<GithubProfile> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bigbluebam-oauth',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub profile fetch failed: ${res.status}`);
  }
  const profile = (await res.json()) as GithubProfile;

  // GitHub only returns a non-null email when the user made it public.
  // Fall back to the verified-primary email from the /user/emails route.
  if (!profile.email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bigbluebam-oauth',
      },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (primary) profile.email = primary.email;
    }
  }

  return profile;
}

async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Google profile fetch failed: ${res.status}`);
  }
  return (await res.json()) as GoogleProfile;
}

let _welcomeQueue: Queue | null = null;
function getWelcomeQueue(): Queue {
  if (!_welcomeQueue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _welcomeQueue = new Queue('email', { connection });
  }
  return _welcomeQueue;
}

async function enqueueWelcomeEmail(to: string, displayName: string): Promise<void> {
  try {
    await getWelcomeQueue().add('welcome', {
      to,
      subject: 'Welcome to BigBlueBam',
      html: `<p>Welcome to BigBlueBam, ${displayName}! Your account is ready.</p>`,
      text: `Welcome to BigBlueBam, ${displayName}! Your account is ready.`,
    });
  } catch {
    // Non-fatal: the worker will log delivery failures separately.
  }
}

async function upsertOAuthUser(params: {
  email: string;
  displayName: string;
  avatarUrl: string | null;
}): Promise<{ userId: string; isNew: boolean }> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.email.toLowerCase()))
    .limit(1);

  if (existing) {
    return { userId: existing.id, isNew: false };
  }

  // New user — create a solo org + membership + user in one transaction,
  // mirroring services/auth.service.ts register().
  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        name: `${params.displayName}'s workspace`,
        slug: `${slugify(params.displayName || params.email.split('@')[0]!)}-${Date.now().toString(36)}`,
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        org_id: org!.id,
        email: params.email.toLowerCase(),
        display_name: params.displayName,
        avatar_url: params.avatarUrl,
        password_hash: null,
        role: 'owner',
        email_verified: true,
      })
      .returning();

    await tx.insert(organizationMemberships).values({
      user_id: user!.id,
      org_id: org!.id,
      role: 'owner',
      is_default: true,
    });

    return user!;
  });

  return { userId: result.id, isNew: true };
}

export default async function oauthRoutes(fastify: FastifyInstance) {
  const cookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: env.SESSION_TTL_SECONDS,
  };

  // FRONTEND_URL is canonically set to http://host/b3 (or https equivalent).
  // The SPA is served from /b3/ and the Fastify api is proxied under
  // /b3/api/. Strip a trailing slash defensively, then derive the api
  // base for callback URIs as `<frontend>/api`. Redirect on success to
  // the SPA root with a one-time flag the client uses to show a toast.
  const frontendBase = env.FRONTEND_URL.replace(/\/$/, '');
  const apiBase = `${frontendBase}/api`;
  const redirectTarget = `${frontendBase}/?oauth=complete`;

  const githubConfigured = Boolean(env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET);
  const googleConfigured = Boolean(env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET);

  if (githubConfigured) {
    await fastify.register(oauth2, {
      name: 'githubOAuth2',
      scope: ['user:email'],
      credentials: {
        client: {
          id: env.OAUTH_GITHUB_CLIENT_ID!,
          secret: env.OAUTH_GITHUB_CLIENT_SECRET!,
        },
        auth: oauth2.GITHUB_CONFIGURATION,
      },
      startRedirectPath: '/auth/oauth/github',
      callbackUri: `${apiBase}/auth/oauth/github/callback`,
    });

    fastify.get('/auth/oauth/github/callback', async (request, reply) => {
      try {
        const tokenResult = await fastify.githubOAuth2!.getAccessTokenFromAuthorizationCodeFlow(request);
        const accessToken = tokenResult.token.access_token;
        const profile = await fetchGithubProfile(accessToken);

        if (!profile.email) {
          return reply.status(400).send({
            error: {
              code: 'OAUTH_NO_EMAIL',
              message: 'GitHub did not return a verified email for this account',
              details: [],
              request_id: request.id,
            },
          });
        }

        const { userId, isNew } = await upsertOAuthUser({
          email: profile.email,
          displayName: profile.name ?? profile.login ?? profile.email.split('@')[0]!,
          avatarUrl: profile.avatar_url,
        });

        if (isNew) {
          await enqueueWelcomeEmail(profile.email, profile.name ?? profile.login ?? 'there');
        }

        const session = await createSession(userId, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.setCookie('session', session.id, cookieOptions);
        issueCsrfToken(reply);
        return reply.redirect(redirectTarget);
      } catch (err) {
        request.log.error({ err }, 'GitHub OAuth callback failed');
        return reply.status(500).send({
          error: {
            code: 'OAUTH_CALLBACK_FAILED',
            message: 'Failed to complete GitHub OAuth flow',
            details: [],
            request_id: request.id,
          },
        });
      }
    });
  } else {
    fastify.get('/auth/oauth/github', async (_request, reply) => {
      return reply.status(503).send({
        error: {
          code: 'OAUTH_NOT_CONFIGURED',
          message: 'GitHub OAuth is not configured on this server. Set OAUTH_GITHUB_CLIENT_ID and OAUTH_GITHUB_CLIENT_SECRET.',
          details: [],
        },
      });
    });
  }

  if (googleConfigured) {
    await fastify.register(oauth2, {
      name: 'googleOAuth2',
      scope: ['openid', 'email', 'profile'],
      credentials: {
        client: {
          id: env.OAUTH_GOOGLE_CLIENT_ID!,
          secret: env.OAUTH_GOOGLE_CLIENT_SECRET!,
        },
        auth: oauth2.GOOGLE_CONFIGURATION,
      },
      startRedirectPath: '/auth/oauth/google',
      callbackUri: `${apiBase}/auth/oauth/google/callback`,
    });

    fastify.get('/auth/oauth/google/callback', async (request, reply) => {
      try {
        const tokenResult = await fastify.googleOAuth2!.getAccessTokenFromAuthorizationCodeFlow(request);
        const accessToken = tokenResult.token.access_token;
        const profile = await fetchGoogleProfile(accessToken);

        if (!profile.email || !profile.email_verified) {
          return reply.status(400).send({
            error: {
              code: 'OAUTH_NO_EMAIL',
              message: 'Google did not return a verified email for this account',
              details: [],
              request_id: request.id,
            },
          });
        }

        const { userId, isNew } = await upsertOAuthUser({
          email: profile.email,
          displayName: profile.name ?? profile.email.split('@')[0]!,
          avatarUrl: profile.picture ?? null,
        });

        if (isNew) {
          await enqueueWelcomeEmail(profile.email, profile.name ?? 'there');
        }

        const session = await createSession(userId, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.setCookie('session', session.id, cookieOptions);
        issueCsrfToken(reply);
        return reply.redirect(redirectTarget);
      } catch (err) {
        request.log.error({ err }, 'Google OAuth callback failed');
        return reply.status(500).send({
          error: {
            code: 'OAUTH_CALLBACK_FAILED',
            message: 'Failed to complete Google OAuth flow',
            details: [],
            request_id: request.id,
          },
        });
      }
    });
  } else {
    fastify.get('/auth/oauth/google', async (_request, reply) => {
      return reply.status(503).send({
        error: {
          code: 'OAUTH_NOT_CONFIGURED',
          message: 'Google OAuth is not configured on this server. Set OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET.',
          details: [],
        },
      });
    });
  }
}
