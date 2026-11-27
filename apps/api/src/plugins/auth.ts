import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions } from '../db/schema/sessions.js';
import { users } from '../db/schema/users.js';
import { impersonationSessions } from '../db/schema/impersonation-sessions.js';
import {
  isLiveOrg,
  loadLiveMemberships,
  loadOrgRoles,
  touchApiKey,
  verifyApiKeyToken,
} from '../services/auth-identity.service.js';
import { ORG_ADMIN_ROLES, keyRoleCapApplies } from '../services/role-resolver.js';
import { resolveEffectiveOrg } from './org-context.js';

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
  /**
   * Actor kind from users.kind (migration 0127 / AGENTIC_TODO §10). Used by
   * agent-only routes (heartbeat, self-report) to gate on "this must be a
   * service account" without string-matching the bbam_svc_ key prefix.
   */
  kind: 'human' | 'agent' | 'service';
  api_key_scope: string | null;
  org_memberships: OrgMembership[];
  active_org_id: string;
  /**
   * True when a SuperUser is currently viewing a context (org) that is not
   * their home/default org, as set via POST /superuser/context/switch (the
   * `active_org_id` is stored on the session row and honored here). Writes
   * made while this is true are tagged `via_superuser_context` in the
   * activity_log.
   */
  is_superuser_viewing: boolean;
}

export interface SessionContext {
  id: string;
  activeOrgId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionId: string | null;
    session: SessionContext | null;
    impersonator: AuthUser | null;  // the SuperUser doing the impersonating
    isImpersonating: boolean;
    /**
     * True when the current request's org context was derived from a
     * SuperUser switched context (sessions.active_org_id) rather than the
     * user's home/default org membership. Used to tag writes in activity_log.
     */
    viaSuperuserContext: boolean;
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
  kind: 'human' | 'agent' | 'service';
}

/**
 * Resolves the active organization context for a user.
 *
 * Precedence:
 *   1. X-Org-Id request header (if user is a member of that org)
 *   2. The user's default membership (is_default=true)
 *   3. The user's first membership (by joined_at)
 *   4. Fallback to users.org_id if no memberships exist yet (pre-migration)
 */
async function resolveOrgContext(
  userId: string,
  fallbackOrgId: string,
  requestedOrgId: string | undefined,
): Promise<{ memberships: OrgMembership[]; activeOrgId: string; activeRole: string }> {
  // Wave E.F: role is no longer a column on organization_memberships. It
  // is resolved per-org from account_group_memberships → permission_groups.
  // We fetch memberships and roles in parallel (auth-identity.service, the
  // same join resolveUserOrgRoles performs), then zip each membership row
  // with its resolved role.
  // Runs before the org GUC is bound, so it reads through the identity
  // functions (#105, services/auth-identity.service.ts). Memberships exclude
  // soft-deleted orgs (migration 0191): a member can never resolve into a
  // deleted org even if a membership row lingers.
  const [rows, rolesByOrg] = await Promise.all([loadLiveMemberships(userId), loadOrgRoles(userId)]);

  if (rows.length === 0) {
    // User hasn't been backfilled yet — fall back to users.org_id.
    // If users.org_id is also NULL/empty, the user has no valid org context.
    if (!fallbackOrgId) {
      throw new OrgMembershipError('User has no organization memberships and no fallback org_id');
    }
    // Don't fall back into a soft-deleted org (single-org member of a deleted
    // org → orgless, not silently re-resolved into the dead org).
    if (!(await isLiveOrg(fallbackOrgId))) {
      throw new OrgMembershipError('User has no active organization memberships');
    }
    const fallbackRole = rolesByOrg.get(fallbackOrgId) ?? 'member';
    return {
      memberships: [
        { org_id: fallbackOrgId, role: fallbackRole, is_default: true },
      ],
      activeOrgId: fallbackOrgId,
      activeRole: fallbackRole,
    };
  }

  // Sort by joined_at ascending so "first membership" is deterministic.
  rows.sort((a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime());

  const memberships: OrgMembership[] = rows.map((r) => ({
    org_id: r.org_id,
    // A membership without a group row is treated as 'member' by default.
    // The Wave A backfill (migration 0148) ensured every existing
    // membership had a matching group row, so this fallback is only hit
    // when a row is created outside the supported write paths.
    role: rolesByOrg.get(r.org_id) ?? 'member',
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
  // Validate UUID shape; silently ignore malformed header values.
  if (value.length !== 36 || !UUID_REGEX_HEADER.test(value)) return undefined;
  return value;
}

export async function buildAuthUser(
  row: BaseUserRow,
  apiKeyScope: string | null,
  request: FastifyRequest,
  sessionActiveOrgId: string | null = null,
  apiKeyOrgId: string | null = null,
): Promise<AuthUser> {
  // P2-8: For API-key auth on non-SuperUser callers, the key's own org_id
  // is authoritative — X-Org-Id header is ignored. For SuperUser API keys
  // we still honor X-Org-Id (same rules as session auth) because
  // SuperUsers can legitimately operate across orgs.
  const requestedOrgId =
    apiKeyOrgId && !row.is_superuser ? undefined : getRequestedOrgId(request);
  const { memberships, activeOrgId, activeRole } = await resolveOrgContext(
    row.id,
    row.org_id,
    requestedOrgId,
  );

  // P2-8: Pin the effective org to the key's org_id for non-SuperUser
  // API-key auth. We still resolve memberships above so downstream code
  // has the full membership list; we just override the "active" org.
  let keyScopedOrgId: string | null = null;
  let keyScopedRole: string | null = null;
  if (apiKeyOrgId && !row.is_superuser) {
    const keyMembership = memberships.find((m) => m.org_id === apiKeyOrgId);
    // Use the user's role within the key's org. If the user is no longer
    // a member of the key's org (revoked), fall back to 'viewer'. The key's
    // scope gates write access and requireScope('admin') ALSO requires this
    // role to be admin/owner, so a removed holder's admin key opens nothing
    // org-admin (#336).
    keyScopedOrgId = apiKeyOrgId;
    keyScopedRole = keyMembership?.role ?? 'viewer';
  }

  // Resolve the effective org/role + SuperUser-viewing banner. The precedence
  // (API-key pin > explicit X-Org-Id header > sticky session active_org_id >
  // membership default) lives in the pure `resolveEffectiveOrg` so it stays
  // unit-tested in isolation (apps/api/test/auth-org-precedence.test.ts) — that
  // is where the e6c9b731 regression (sticky session org clobbering an explicit
  // X-Org-Id header) is pinned.
  const { orgId: finalOrgId, role: finalRole, isSuperuserViewing } = resolveEffectiveOrg({
    keyScopedOrgId,
    keyScopedRole,
    activeOrgId,
    activeRole,
    requestedOrgId,
    sessionActiveOrgId,
    memberships,
    isSuperuser: row.is_superuser,
  });

  return {
    id: row.id,
    org_id: finalOrgId,
    email: row.email,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    role: finalRole,
    timezone: row.timezone,
    is_active: row.is_active,
    is_superuser: row.is_superuser,
    kind: row.kind,
    api_key_scope: apiKeyScope,
    org_memberships: memberships,
    active_org_id: finalOrgId,
    is_superuser_viewing: isSuperuserViewing,
  };
}

/**
 * Resolves the current org id for a request, applying SuperUser context
 * switch rules. Returns both the org id and a flag indicating whether the
 * SuperUser-viewing override was applied. This is the canonical helper for
 * "which org is this request acting on". Most route handlers should prefer
 * `request.user.active_org_id` (already resolved) — this exists for callers
 * outside the auth hook that need to inspect the rule directly.
 */
export function resolveCurrentOrgId(
  _session: SessionContext | null,
  user: Pick<AuthUser, 'active_org_id' | 'is_superuser_viewing'> | null,
): { orgId: string | null; isSuperuserViewing: boolean } {
  if (!user) return { orgId: null, isSuperuserViewing: false };
  return { orgId: user.active_org_id, isSuperuserViewing: user.is_superuser_viewing };
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
  fastify.decorateRequest('session', null);
  fastify.decorateRequest('impersonator', null);
  fastify.decorateRequest('isImpersonating', false);
  fastify.decorateRequest('viaSuperuserContext', false);

  // P1-19: is_active is checked at this auth preHandler on every request
  // (the JOIN fetches users.is_active fresh each time). Long-running handlers
  // may continue with stale is_active=true if a user is deactivated after
  // this check passes. For typical request durations (<100ms) the window is
  // negligible; we accept this trade-off rather than re-querying mid-handler.
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
            kind: users.kind,
            last_seen_at: users.last_seen_at,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.user_id, users.id))
        .where(eq(sessions.id, sessionId))
        .limit(1);

      const row = result[0];
      if (row && new Date(row.session.expires_at).getTime() + 30_000 > Date.now() && row.user.is_active) {
        const sessionActiveOrgId = row.session.active_org_id ?? null;
        request.user = await buildAuthUser(row.user, null, request, sessionActiveOrgId);
        request.sessionId = sessionId;
        request.session = {
          id: sessionId,
          activeOrgId: sessionActiveOrgId,
        };
        request.viaSuperuserContext = request.user.is_superuser_viewing;

        // Fire-and-forget update of sessions.last_used_at, throttled to at
        // most one write per 60 seconds per session. We check the value we
        // already SELECTed above rather than re-reading.
        const lastUsed = row.session.last_used_at
          ? new Date(row.session.last_used_at).getTime()
          : 0;
        if (Date.now() - lastUsed > 60_000) {
          db.update(sessions)
            .set({ last_used_at: new Date() })
            .where(eq(sessions.id, sessionId))
            .catch((err) => {
              request.log.warn({ err }, 'Failed to update sessions.last_used_at');
            });
        }

        // Also bump users.last_seen_at, throttled to at most once per 5
        // minutes per user. This drives the presence dots in Banter.
        const lastSeen = row.user.last_seen_at
          ? new Date(row.user.last_seen_at).getTime()
          : 0;
        if (Date.now() - lastSeen > 5 * 60_000) {
          db.update(users)
            .set({ last_seen_at: new Date() })
            .where(eq(users.id, row.user.id))
            .catch((err) => {
              request.log.warn({ err }, 'Failed to update users.last_seen_at');
            });
        }
        return;
      }
    }

    // Try Bearer token (API key)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      // One verification rule for every bbam_ token the api accepts (Bearer
      // here, ?token= on the iCal feed): expiry, rotation grace, the #40
      // service-account bucket, the P2-11 DoS cap and owner state all live in
      // verifyApiKeyToken.
      const verified = await verifyApiKeyToken(authHeader.slice(7), request.log);
      if (verified) {
        // P2-8: pass the key's org_id. For non-SuperUser keys this pins the
        // request's org context to the key's org regardless of what X-Org-Id
        // says or which orgs the user now belongs to.
        request.user = await buildAuthUser(verified.user, verified.apiKey.scope, request, null, verified.apiKey.org_id);
        // Update last_used_at: fire-and-forget, log errors but don't block the response.
        touchApiKey(verified.apiKey.id).catch((err) => {
          console.warn('Failed to update api_keys.last_used_at:', err);
        });
        return;
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

  // Impersonation hook: runs AFTER main auth, only SuperUsers can impersonate
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    const impersonateHeader = getImpersonateHeader(request);
    if (!impersonateHeader) return;
    // Silently ignore if not a superuser
    if (!request.user || request.user.is_superuser !== true) return;
    // Validate UUID shape
    if (typeof impersonateHeader !== 'string' || impersonateHeader.length !== 36) return;
    if (!UUID_REGEX.test(impersonateHeader)) return;
    // No-op on self-impersonation
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
        kind: users.kind,
      })
      .from(users)
      .where(eq(users.id, impersonateHeader))
      .limit(1);

    const target = result[0];
    if (!target) return;
    if (!target.is_active) return;
    if (target.is_superuser) return; // prevent SU impersonation chaining

    // Require an active (non-expired, non-ended) impersonation session
    // created via POST /v1/platform/impersonate.
    const now = new Date();
    const activeSession = await db
      .select({ id: impersonationSessions.id })
      .from(impersonationSessions)
      .where(
        and(
          eq(impersonationSessions.superuser_id, request.user.id),
          eq(impersonationSessions.target_user_id, target.id),
          isNull(impersonationSessions.ended_at),
          gt(impersonationSessions.expires_at, now),
        ),
      )
      .limit(1);

    if (activeSession.length === 0) return;

    request.impersonator = request.user;
    // Impersonation swaps to the target user. The target is not a SuperUser
    // (we rejected SU→SU above), so they cannot be "viewing" via a switched
    // context — reset the flag regardless of what the SU's session had.
    request.user = await buildAuthUser(target, null, request);
    request.isImpersonating = true;
    request.viaSuperuserContext = false;
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

/** Org roles that satisfy an `admin`-scoped gate under session auth. */

/** Requires the API key scope to allow the given operation type.
 *  Hierarchy: admin > read_write > read
 *  SuperUsers always pass.
 *  Session auth (no API key): `read` / `read_write` pass, but an `admin` gate
 *  requires the caller's active-org role to be admin or owner. */
export function requireScope(minScope: 'read' | 'read_write' | 'admin') {
  const scopeHierarchy = ['read', 'read_write', 'admin'];
  const minLevel = scopeHierarchy.indexOf(minScope);

  // Known limitation (P1-23): Scope is cached at auth time; revoked keys
  // remain valid until request completes. Re-querying on every scope check
  // would add a DB round-trip to every authorized call — the window is
  // bounded by request duration so we accept this trade-off.
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
    if (request.user.is_superuser) return;
    // requireScope('admin') is the org-admin gate on ~40 routes (org settings
    // and SMTP override, member invites/removal, password resets, minting API
    // keys for other members, guests, priorities). A session carries no key
    // scope, and requireCan blocks nothing unless BBB_PERMISSIONS_ENFORCE=on,
    // so before this check any member, viewer or guest passed every one of
    // them. Enforced in every posture; read / read_write have no role analog.
    if (request.user.api_key_scope === null) {
      if (minScope === 'admin' && !ORG_ADMIN_ROLES.has(request.user.role)) {
        request.log.warn(
          { userId: request.user.id, role: request.user.role, path: request.url, method: request.method },
          'requireScope(admin): denied a non-admin session on an org-admin route',
        );
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Organization admin privileges required',
            details: [],
            request_id: request.id,
          },
        });
      }
      return;
    }

    const userScopeLevel = scopeHierarchy.indexOf(request.user.api_key_scope);
    if (userScopeLevel < minLevel) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: `API key requires '${minScope}' scope or higher`,
          details: [],
          request_id: request.id,
        },
      });
    }
    // #336: a key's effective privilege is the intersection of its scope and
    // the holder's CURRENT org role. An admin-scope key minted while its
    // holder was an owner must stop opening org-admin routes once they are
    // demoted (role member) or removed (buildAuthUser falls back to viewer).
    if (
      minScope === 'admin' &&
      keyRoleCapApplies(request.user.kind) &&
      !ORG_ADMIN_ROLES.has(request.user.role)
    ) {
      request.log.warn(
        { userId: request.user.id, role: request.user.role, path: request.url, method: request.method },
        'requireScope(admin): denied an admin-scope API key whose holder is no longer an org admin',
      );
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Organization admin privileges required',
          details: [],
          request_id: request.id,
        },
      });
    }
  };
}

