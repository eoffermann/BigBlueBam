import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import {
  applyKeyOrgPin,
  bearerToken,
  isApiKeyOrgPinned,
  resolveKeyOrgPin,
  sqlApiKeyStore,
  verifyApiKeyToken,
} from '@bigbluebam/auth-core';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  organizationMemberships,
  accountGroupMemberships,
  permissionGroups,
  impersonationSessions,
} from '../db/schema/index.js';

/** This service's binding of the shared bbam_ key store: its own db.execute and argon2. */
const apiKeyStore = sqlApiKeyStore({
  sql,
  execute: (query) => db.execute(query),
  verifyHash: (hash, token) => argon2.verify(hash, token),
});

const UUID_REGEX_HEADER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrgMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgMembershipError';
  }
}

export interface OrgMembership {
  org_id: string;
  role: string;
  is_default: boolean;
}

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

async function resolveOrgContext(
  userId: string,
  fallbackOrgId: string,
  requestedOrgId: string | undefined,
): Promise<{ memberships: OrgMembership[]; activeOrgId: string; activeRole: string }> {
  const rows = await db
    .select({
      org_id: organizationMemberships.org_id,
      role: permissionGroups.legacy_role,
      is_default: organizationMemberships.is_default,
      joined_at: organizationMemberships.joined_at,
    })
    .from(organizationMemberships)
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

  if (rows.length === 0) {
    if (!fallbackOrgId) {
      throw new OrgMembershipError('User has no organization memberships and no fallback org_id');
    }
    return {
      memberships: [{ org_id: fallbackOrgId, role: 'member', is_default: true }],
      activeOrgId: fallbackOrgId,
      activeRole: 'member',
    };
  }

  rows.sort((a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime());

  const memberships: OrgMembership[] = rows.map((r) => ({
    org_id: r.org_id,
    role: r.role ?? 'member',
    is_default: r.is_default,
  }));

  let active: OrgMembership | undefined;
  if (requestedOrgId) {
    active = memberships.find((m) => m.org_id === requestedOrgId);
    if (!active) {
      throw new OrgMembershipError(
        `User is not a member of the requested organization: ${requestedOrgId}`,
      );
    }
  }
  if (!active) {
    active = memberships.find((m) => m.is_default);
  }
  if (!active) {
    active = memberships[0];
  }

  return {
    memberships,
    activeOrgId: active!.org_id,
    activeRole: active!.role,
  };
}

function getRequestedOrgId(request: FastifyRequest): string | undefined {
  const header = request.headers['x-org-id'];
  let value: string | undefined;
  if (typeof header === 'string' && header.length > 0) value = header;
  else if (Array.isArray(header) && header.length > 0) value = header[0];
  if (!value) return undefined;
  if (value.length !== 36 || !UUID_REGEX_HEADER.test(value)) return undefined;
  return value;
}

// P2-8: whether a key is pinned to its own org, and the org/role it then acts with, are
// @bigbluebam/auth-core's (isApiKeyOrgPinned, resolveKeyOrgPin), shared by every service (#340).
export { isApiKeyOrgPinned };

export async function buildAuthUser(
  row: BaseUserRow,
  apiKeyScope: string | null,
  request: FastifyRequest,
  apiKeyOrgId: string | null = null,
): Promise<AuthUser> {
  const pinned = isApiKeyOrgPinned(apiKeyOrgId, row.is_superuser);
  // When pinned, the X-Org-Id header is discarded OUTRIGHT rather than validated against
  // the key's org: passing it through to resolveOrgContext would throw
  // OrgMembershipError (403) for a header naming an org the user is not in, which is a
  // membership probe. Ignoring it is both safer and what apps/api does.
  const requestedOrgId = pinned ? undefined : getRequestedOrgId(request);
  const { memberships, activeOrgId, activeRole } = await resolveOrgContext(
    row.id,
    row.org_id,
    requestedOrgId,
  );

  // The key's org and the holder's CURRENT role there ('viewer' once they left it), so losing
  // membership strips role-derived privilege. Memberships stay resolved in full above.
  const pin = pinned ? resolveKeyOrgPin(apiKeyOrgId, row.is_superuser, memberships) : null;
  const effectiveOrgId = pin?.orgId ?? activeOrgId;
  const effectiveRole = pin?.role ?? activeRole;

  return {
    id: row.id,
    org_id: effectiveOrgId,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    role: effectiveRole,
    timezone: row.timezone,
    is_active: row.is_active,
    is_superuser: row.is_superuser,
    api_key_scope: apiKeyScope,
    org_memberships: memberships,
    active_org_id: effectiveOrgId,
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
            session: sessions,
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
          request.user = await buildAuthUser(row.user, null, request);
          request.sessionId = sessionId;
          return;
        }
      }

      // Bearer API key. Verification (expiry, rotation grace, DoS caps, owner state), the
      // org pin and requireScope are @bigbluebam/auth-core's, shared by every service (#340).
      const token = bearerToken(request.headers.authorization);
      const verified = token ? await verifyApiKeyToken(token, apiKeyStore, request.log) : null;
      if (verified) {
        // P2-8: a non-SuperUser key acts only in its own org, whatever X-Org-Id says, so the
        // header is dropped rather than resolved (or probed) against the user's memberships.
        if (isApiKeyOrgPinned(verified.apiKey.org_id, verified.user.is_superuser)) {
          request.headers['x-org-id'] = undefined;
        }
        const user = await buildAuthUser(verified.user, verified.apiKey.scope, request, verified.apiKey.org_id);
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

  // Impersonation hook
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
    if (!target || !target.is_active || target.is_superuser) return;

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
