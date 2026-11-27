import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  applyKeyOrgPin,
  bearerToken,
  isApiKeyOrgPinned,
  type OrgMembership,
  OrgMembershipError,
  refuseProjectRestrictedKey,
  requestedOrgIdFromHeader,
  resolveOrgContext,
  sqlApiKeyStore,
  sqlOrgContextStore,
  verifyApiKeyToken,
} from '@bigbluebam/auth-core';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  impersonationSessions,
} from '../db/schema/index.js';

/** This service's binding of the shared bbam_ key store: its own db.execute and argon2. */
const apiKeyStore = sqlApiKeyStore({
  sql,
  execute: (query) => db.execute(query),
  verifyHash: (hash, token) => argon2.verify(hash, token),
});

/**
 * This service's binding of the shared org-context store: memberships, roles and org liveness
 * read through migration 0311's identity functions, so soft-deleted orgs never resolve and the
 * reads work before any org is bound under BBB_RLS_ENFORCE=1 (#350).
 */
const orgContextStore = sqlOrgContextStore({ sql, execute: (query) => db.execute(query) });

// Org-context errors and membership shape are auth-core's; re-exported for existing importers.
export { OrgMembershipError };
export type { OrgMembership };

export interface AuthUser {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
  /** users.kind; set for API-key auth (requireScope's #336 role cap exempts service/agent). */
  kind?: 'human' | 'agent' | 'service';
  api_key_scope: string | null;
  org_memberships: OrgMembership[];
  active_org_id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    impersonator: AuthUser | null;
    isImpersonating: boolean;
  }
}

interface BaseUserRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
}

async function buildAuthUser(
  row: BaseUserRow,
  apiKeyScope: string | null,
  request: FastifyRequest,
  sessionActiveOrgId: string | null = null,
): Promise<AuthUser> {
  const requestedOrgId = requestedOrgIdFromHeader(request.headers['x-org-id']);
  const { memberships, activeOrgId, activeRole } = await resolveOrgContext(
    orgContextStore,
    row.id,
    row.org_id,
    requestedOrgId,
    // Banter honors the session's switched org (Bam's /auth/switch-org shares the cookie) and
    // lets a SuperUser view any live org, mirroring Bam's cross-org SU visibility.
    { sessionActiveOrgId, isSuperuser: row.is_superuser, superuserMayViewAnyOrg: true },
  );

  return {
    id: row.id,
    org_id: activeOrgId,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    role: activeRole,
    timezone: row.timezone,
    is_active: row.is_active,
    is_superuser: row.is_superuser,
    api_key_scope: apiKeyScope,
    org_memberships: memberships,
    active_org_id: activeOrgId,
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getImpersonateHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-impersonate-user'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('sessionId', null);
  fastify.decorateRequest('impersonator', null);
  fastify.decorateRequest('isImpersonating', false);

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
    // Try session cookie first
    const sessionId = request.cookies?.session;
    if (sessionId) {
      const result = await db
        .select({
          session: {
            id: sessions.id,
            expires_at: sessions.expires_at,
            active_org_id: sessions.active_org_id,
          },
          user: {
            id: users.id,
            org_id: users.org_id,
            email: users.email,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
            timezone: users.timezone,
            is_active: users.is_active,
            is_superuser: users.is_superuser,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.user_id, users.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);

      const row = result[0];
      if (row && new Date(row.session.expires_at) > new Date() && row.user.is_active) {
        const sessionActiveOrgId = row.session.active_org_id ?? null;
        request.user = await buildAuthUser(row.user, null, request, sessionActiveOrgId);
        request.sessionId = sessionId;
        return;
      }
    }

    // Bearer API key. Verification (expiry, rotation grace, DoS caps, owner state), the
    // org pin and requireScope are @bigbluebam/auth-core's, shared by every service (#340).
    const token = bearerToken(request.headers.authorization);
    const verified = token ? await verifyApiKeyToken(token, apiKeyStore, request.log) : null;
    if (verified) {
      // #352: this service has no Bam project context to confine a project-restricted key to,
      // so such a key is refused here rather than handed the holder's whole org.
      const restricted = refuseProjectRestrictedKey(request, reply, verified.apiKey.project_ids);
      if (restricted) return restricted;
      // P2-8: a non-SuperUser key acts only in its own org, whatever X-Org-Id says, so the
      // header is dropped rather than resolved (or probed) against the user's memberships.
      if (isApiKeyOrgPinned(verified.apiKey.org_id, verified.user.is_superuser)) {
        request.headers['x-org-id'] = undefined;
      }
      const user = await buildAuthUser(verified.user, verified.apiKey.scope, request);
      applyKeyOrgPin(user, verified.apiKey.org_id);
      user.kind = verified.user.kind;
      request.user = user;
      apiKeyStore.touch(verified.apiKey.id).catch((err: unknown) => {
        request.log.warn({ err }, 'Failed to update api_keys.last_used_at');
      });
      return;
    }
    } catch (err) {
      if (err instanceof OrgMembershipError) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: err.message,
            details: [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });

  // Impersonation hook: runs AFTER main auth, only SuperUsers can impersonate
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    const impersonateHeader = getImpersonateHeader(request);
    if (!impersonateHeader) return;
    if (!request.user || request.user.is_superuser !== true) return;
    if (typeof impersonateHeader !== 'string' || impersonateHeader.length !== 36) return;
    if (!UUID_REGEX.test(impersonateHeader)) return;
    if (impersonateHeader === request.user.id) return;

    const result = await db
      .select({
        id: users.id,
        org_id: users.org_id,
        email: users.email,
        display_name: users.display_name,
        avatar_url: users.avatar_url,
        timezone: users.timezone,
        is_active: users.is_active,
        is_superuser: users.is_superuser,
      })
      .from(users)
      .where(eq(users.id, impersonateHeader))
      .limit(1);

    const target = result[0];
    if (!target) return;
    if (!target.is_active) return;
    if (target.is_superuser) return;

    // Require an active (non-expired, non-ended) impersonation session
    // for this (superuser, target) pair, created via POST
    // /v1/platform/impersonate on the Bam api. The impersonation_sessions
    // table is shared across the suite (one Postgres DB), so this satellite
    // honors the same 30-minute TTL as the Bam api auth plugin. Fail closed:
    // if no active session exists, do NOT swap to the target user.
    const impersonator = request.user;
    const now = new Date();
    const activeSession = await db
      .select({ id: impersonationSessions.id })
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.superuser_id, impersonator.id),
          eq(impersonationSessions.target_user_id, target.id),
          isNull(impersonationSessions.ended_at),
          gt(impersonationSessions.expires_at, now),
        ),
      )
      .limit(1);
    if (activeSession.length === 0) return;

    request.impersonator = request.user;
    request.user = await buildAuthUser(target, null, request);
    request.isImpersonating = true;
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.isImpersonating && request.impersonator) {
      reply.header('X-Impersonating', 'true');
      reply.header('X-Impersonator', request.impersonator.id);
    }
  });
}

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        details: [],
        request_id: request.id,
      },
    });
  }
}

// requireScope is @bigbluebam/auth-core's, the one gate every service uses (#340).
export { requireScope } from '@bigbluebam/auth-core';
