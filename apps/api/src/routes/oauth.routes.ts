import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { oauthProviders } from '../db/schema/oauth-providers.js';
import { oauthUserLinks } from '../db/schema/oauth-user-links.js';
import { users } from '../db/schema/users.js';
import { organizations } from '../db/schema/organizations.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { sessions } from '../db/schema/sessions.js';
import { setUserOrgRole } from '../services/role-resolver.js';
import { seedDefaultPriorities } from '../services/priorities.service.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Wave 1.A OAuth SSO routes.
 *
 * Minimal but functional: provider list, authorize URL generation,
 * callback exchange, and link-to-existing-account. Supports GitHub
 * and Google and any other row in oauth_providers that has the same
 * basic OAuth 2.0 authorization_code shape.
 *
 * State tokens are stored in Redis with 5-minute TTL so the callback
 * can verify the authorize hop originated here.
 */

const OAUTH_STATE_TTL_SECONDS = 300;
const OAUTH_STATE_KEY = (token: string) => `oauth:state:${token}`;

interface ProviderRow {
  id: string;
  provider_name: string;
  client_id: string;
  client_secret: string;
  authorization_url: string;
  token_url: string;
  user_info_url: string;
  scopes: string;
  enabled: boolean;
}

async function loadProvider(name: string): Promise<ProviderRow | null> {
  const [row] = await db
    .select()
    .from(oauthProviders)
    .where(eq(oauthProviders.provider_name, name))
    .limit(1);
  return (row as ProviderRow | undefined) ?? null;
}

async function exchangeCodeForToken(
  provider: ProviderRow,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; token_type?: string }> {
  const body = new URLSearchParams({
    client_id: provider.client_id,
    client_secret: provider.client_secret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetch(provider.token_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return (await res.json()) as { access_token: string; token_type?: string };
}

async function fetchProviderUser(
  provider: ProviderRow,
  accessToken: string,
): Promise<{ id: string; email: string; name?: string; login?: string }> {
  const res = await fetch(provider.user_info_url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`user_info fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  // Normalize across GitHub and Google payload shapes.
  const id = String(data.id ?? data.sub ?? '');
  const email = String(data.email ?? '');
  const name =
    typeof data.name === 'string'
      ? data.name
      : typeof data.login === 'string'
      ? (data.login as string)
      : undefined;
  const login = typeof data.login === 'string' ? (data.login as string) : undefined;
  if (!id || !email) {
    throw new Error('provider returned incomplete profile (missing id or email)');
  }
  return { id, email, name, login };
}

function slugifyOrg(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export default async function oauthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/oauth/providers', async (_request, reply) => {
    const rows = await db
      .select({
        provider_name: oauthProviders.provider_name,
        enabled: oauthProviders.enabled,
      })
      .from(oauthProviders)
      .where(eq(oauthProviders.enabled, true));

    return reply.send({
      data: rows.map((r) => ({ name: r.provider_name, enabled: r.enabled })),
    });
  });

  fastify.get<{ Params: { provider: string }; Querystring: { redirect_uri?: string } }>(
    '/auth/oauth/:provider/authorize',
    async (request, reply) => {
      const provider = await loadProvider(request.params.provider);
      if (!provider || !provider.enabled) {
        return reply.status(404).send({
          error: {
            code: 'PROVIDER_NOT_FOUND',
            message: 'OAuth provider is not configured or disabled',
            details: [],
            request_id: request.id,
          },
        });
      }

      const state = randomBytes(24).toString('base64url');
      const redirectUri = request.query.redirect_uri ?? '';

      try {
        await fastify.redis.set(
          OAUTH_STATE_KEY(state),
          JSON.stringify({ provider: provider.provider_name, redirect_uri: redirectUri }),
          'EX',
          OAUTH_STATE_TTL_SECONDS,
        );
      } catch (err) {
        request.log.error({ err }, 'oauth authorize: failed to store state');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Could not initialize OAuth flow',
            details: [],
            request_id: request.id,
          },
        });
      }

      const url = new URL(provider.authorization_url);
      url.searchParams.set('client_id', provider.client_id);
      url.searchParams.set('scope', provider.scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

      return reply.send({
        data: { authorization_url: url.toString(), state },
      });
    },
  );

  fastify.post<{
    Params: { provider: string };
    Body: { code: string; state: string; redirect_uri?: string };
  }>('/auth/oauth/:provider/callback', async (request, reply) => {
    const schema = z.object({
      code: z.string().min(1),
      state: z.string().min(1),
      redirect_uri: z.string().optional(),
    });
    const body = schema.parse(request.body);

    const stored = await fastify.redis.get(OAUTH_STATE_KEY(body.state));
    if (!stored) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_STATE',
          message: 'OAuth state token is missing or expired',
          details: [],
          request_id: request.id,
        },
      });
    }
    await fastify.redis.del(OAUTH_STATE_KEY(body.state));

    const stateData = JSON.parse(stored) as { provider: string; redirect_uri?: string };
    if (stateData.provider !== request.params.provider) {
      return reply.status(400).send({
        error: {
          code: 'STATE_PROVIDER_MISMATCH',
          message: 'State token does not match requested provider',
          details: [],
          request_id: request.id,
        },
      });
    }

    const provider = await loadProvider(request.params.provider);
    if (!provider || !provider.enabled) {
      return reply.status(404).send({
        error: {
          code: 'PROVIDER_NOT_FOUND',
          message: 'OAuth provider is not configured or disabled',
          details: [],
          request_id: request.id,
        },
      });
    }

    let token: { access_token: string };
    let profile: { id: string; email: string; name?: string; login?: string };
    try {
      token = await exchangeCodeForToken(
        provider,
        body.code,
        body.redirect_uri ?? stateData.redirect_uri ?? '',
      );
      profile = await fetchProviderUser(provider, token.access_token);
    } catch (err) {
      request.log.error({ err }, 'oauth callback: upstream exchange failed');
      return reply.status(502).send({
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'OAuth provider exchange failed',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Look for an existing link first.
    const [existingLink] = await db
      .select()
      .from(oauthUserLinks)
      .where(
        and(
          eq(oauthUserLinks.provider_name, provider.provider_name),
          eq(oauthUserLinks.external_id, profile.id),
        ),
      )
      .limit(1);

    if (existingLink) {
      // Sign the user in by issuing a session. sessions.id IS the token
      // (not a separate column).
      const sessionToken = randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await db.insert(sessions).values({
        id: sessionToken,
        user_id: existingLink.user_id,
        expires_at: expiresAt,
      });
      await db
        .update(oauthUserLinks)
        .set({ last_sync_at: new Date() })
        .where(eq(oauthUserLinks.id, existingLink.id));
      return reply.send({
        data: {
          session_token: sessionToken,
          user_id: existingLink.user_id,
          linked: true,
        },
      });
    }

    // Email collision: an existing user has this email but no link for this provider.
    const [existingUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    if (existingUser) {
      return reply.status(409).send({
        error: {
          code: 'EMAIL_COLLISION',
          message: 'A local account already exists with this email. Sign in and link your OAuth account.',
          details: [{ field: 'email', issue: 'in_use' }],
          request_id: request.id,
        },
      });
    }

    // New user + org. Create a dedicated org named after the profile.
    const orgName = profile.name || profile.email.split('@')[0] || 'New Org';
    const orgSlug = slugifyOrg(orgName) || `oauth-${Date.now()}`;
    const lockedPassword = randomBytes(32).toString('base64url');
    const passwordHash = await argon2.hash(lockedPassword);

    const newUser = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ name: orgName, slug: orgSlug })
        .returning();

      const [user] = await tx
        .insert(users)
        .values({
          org_id: org!.id,
          email: profile.email,
          display_name: profile.name ?? profile.email,
          password_hash: passwordHash,
          is_superuser: false,
        })
        .returning();

      await tx.insert(organizationMemberships).values({
        user_id: user!.id,
        org_id: org!.id,
        is_default: true,
      });
      // Wave E.F: role lives in account_group_memberships.
      await setUserOrgRole(user!.id, org!.id, 'owner', {}, tx);
      await seedDefaultPriorities(tx, org!.id);

      await tx.insert(oauthUserLinks).values({
        user_id: user!.id,
        provider_name: provider.provider_name,
        external_id: profile.id,
        external_email: profile.email,
        external_login: profile.login ?? null,
        last_sync_at: new Date(),
      });

      return user!;
    });

    const sessionToken = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(sessions).values({
      id: sessionToken,
      user_id: newUser.id,
      expires_at: expiresAt,
    });

    return reply.status(201).send({
      data: {
        session_token: sessionToken,
        user_id: newUser.id,
        linked: false,
        new_user: true,
      },
    });
  });

  fastify.post<{
    Params: { provider: string };
    Body: { external_id: string; external_email: string; external_login?: string };
  }>(
    '/auth/oauth/:provider/link',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const schema = z.object({
        external_id: z.string().min(1),
        external_email: z.string().email(),
        external_login: z.string().optional(),
      });
      const body = schema.parse(request.body);

      const provider = await loadProvider(request.params.provider);
      if (!provider || !provider.enabled) {
        return reply.status(404).send({
          error: {
            code: 'PROVIDER_NOT_FOUND',
            message: 'OAuth provider is not configured or disabled',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const [link] = await db
          .insert(oauthUserLinks)
          .values({
            user_id: request.user!.id,
            provider_name: provider.provider_name,
            external_id: body.external_id,
            external_email: body.external_email,
            external_login: body.external_login ?? null,
            last_sync_at: new Date(),
          })
          .returning();

        return reply.status(201).send({
          data: {
            id: link!.id,
            provider: provider.provider_name,
          },
        });
      } catch (err) {
        request.log.error({ err }, 'oauth link: insert failed');
        return reply.status(409).send({
          error: {
            code: 'ALREADY_LINKED',
            message: 'This external account is already linked to a user',
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );
}
