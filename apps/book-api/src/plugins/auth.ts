import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import {
  sessions,
  users,
  apiKeys,
  organizationMemberships,
  accountGroupMemberships,
  permissionGroups,
} from '../db/schema/index.js';

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
  api_key_scope: string | null;
  org_memberships: OrgMembership[];
  active_org_id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
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

async function buildAuthUser(
  row: BaseUserRow,
  apiKeyScope: string | null,
  request: FastifyRequest,
): Promise<AuthUser> {
  const requestedOrgId = getRequestedOrgId(request);
  const { memberships, activeOrgId, activeRole } = await resolveOrgContext(
    row.id,
    row.org_id,
    requestedOrgId,
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

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('sessionId', null);

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

      // Try Bearer token (API key)
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const prefix = token.slice(0, 8);

        const candidates = await db
          .select({
            apiKey: apiKeys,
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
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.user_id, users.id))
          .where(eq(apiKeys.key_prefix, prefix))
          .limit(10);

        const verifyCandidates = candidates.length > 3 ? candidates.slice(0, 1) : candidates;

        for (const candidate of verifyCandidates) {
          const valid = await argon2.verify(candidate.apiKey.key_hash, token);
          if (candidate.apiKey.expires_at && new Date(candidate.apiKey.expires_at) < new Date()) {
            continue;
          }
          if (valid && candidate.user.is_active) {
            request.user = await buildAuthUser(candidate.user, candidate.apiKey.scope, request);
            db.update(apiKeys)
              .set({ last_used_at: new Date() })
              .where(eq(apiKeys.id, candidate.apiKey.id))
              .catch(() => {});
            return;
          }
        }
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
export function requireScope(minScope: string) {
  const SCOPE_HIERARCHY = ['read', 'read_write', 'admin'] as const;
  return async function checkScope(request: FastifyRequest, reply: FastifyReply) {
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
    if (request.user.api_key_scope === null) return;
    if (request.user.is_superuser) return;
    const scopeLevel = SCOPE_HIERARCHY.indexOf(
      request.user.api_key_scope as (typeof SCOPE_HIERARCHY)[number],
    );
    const requiredLevel = SCOPE_HIERARCHY.indexOf(minScope as (typeof SCOPE_HIERARCHY)[number]);
    if (scopeLevel < requiredLevel) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `API key requires at least '${minScope}' scope`,
          details: [],
          request_id: request.id,
        },
      });
    }
  };
}
