import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, isNull, gt } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '../db/index.js';
import { sessions } from '../db/schema/sessions.js';
import { users } from '../db/schema/users.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { organizationMemberships } from '../db/schema/organization-memberships.js';
import { impersonationSessions } from '../db/schema/impersonation-sessions.js';
import { resolveUserOrgRoles } from '../services/role-resolver.js';

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
  // We fetch both in a single round-trip via resolveUserOrgRoles, then
  // zip the per-membership row with its resolved role.
  const [rows, rolesByOrg] = await Promise.all([
    db
      .select({
        org_id: organizationMemberships.org_id,
        is_default: organizationMemberships.is_default,
        joined_at: organizationMemberships.joined_at,
      })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.user_id, userId)),
    resolveUserOrgRoles(userId),
  ]);

  if (rows.length === 0) {
    // User hasn't been backfilled yet — fall back to users.org_id.
    // If users.org_id is also NULL/empty, the user has no valid org context.
    if (!fallbackOrgId) {
      throw new OrgMembershipError('User has no organization memberships and no fallback org_id');
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
    // a member of the key's org (revoked), fall back to 'viewer' — the
    // key's own scope still gates write access, but org membership loss
    // should strip role-derived privileges.
    keyScopedOrgId = apiKeyOrgId;
    keyScopedRole = keyMembership?.role ?? 'viewer';
  }

  // Session-level active_org_id. Set by /auth/switch-org (regular users) and
  // /superuser/context/switch (SuperUsers). We honor it here so both flows
  // pin the request's org context to whatever the user last selected.
  //
  //   - For a regular user: only honor if they are STILL a member of that
  //     org (membership may have been revoked since the switch). Otherwise
  //     silently fall back to the membership-resolved default — the switch
  //     effectively expires.
  //   - For a SuperUser: honor ANY active_org_id, even an org they aren't
  //     a member of (that's the point of SuperUser cross-org visibility).
  //     Their membership role in the target, if any, is preserved; if they
  //     aren't a member we mark them as 'owner' for the switched context
  //     and flip the is_superuser_viewing banner flag.
  let finalOrgId = keyScopedOrgId ?? activeOrgId;
  let finalRole = keyScopedRole ?? activeRole;
  let isSuperuserViewing = false;
  if (sessionActiveOrgId && sessionActiveOrgId !== activeOrgId) {
    const existingMembership = memberships.find((m) => m.org_id === sessionActiveOrgId);
    if (row.is_superuser) {
      finalOrgId = sessionActiveOrgId;
      finalRole = existingMembership?.role ?? 'owner';
      // Only light the cross-org banner when the SU is viewing an org they
      // are NOT a native member of — normal multi-org members who use the
      // switcher shouldn't see the "viewing as SuperUser" banner.
      isSuperuserViewing = !existingMembership;
    } else if (existingMembership) {
      finalOrgId = sessionActiveOrgId;
      finalRole = existingMembership.role;
    }
    // non-SU with no matching membership: leave finalOrgId on the default.
  }

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
      const token = authHeader.slice(7);
      const prefix = token.slice(0, 8);

      // #40: Service-account tokens are `bbam_svc_<random>` — a 9-char literal
      // lead — so token.slice(0, 8) is the constant 'bbam_svc' for EVERY
      // service-account key. The prefix index is degenerate for this one key
      // kind (user keys slice to a ~48-bit base64 or ~18-bit `bbam_`+random
      // prefix and stay selective). An org with several service accounts thus
      // has many rows sharing this single prefix bucket, and the DoS cap below
      // — designed for random-prefix forgery — would wrongly collapse the
      // lookup to one arbitrary row, breaking auth for every other svc-acct
      // key once the org has 4+ of them. Treat the known literal bucket as
      // expected: raise the fetch limit and verify all candidates (bounded by
      // SVC_BUCKET_MAX), while keeping the strict cap for random user-key
      // prefixes where >3 collisions really do signal a forced-Argon2 attempt.
      const SVC_KEY_PREFIX = 'bbam_svc';
      const SVC_BUCKET_MAX = 64;
      const isSvcBucket = prefix === SVC_KEY_PREFIX;

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
            kind: users.kind,
          },
        })
        .from(apiKeys)
        .innerJoin(users, eq(apiKeys.user_id, users.id))
        .where(eq(apiKeys.key_prefix, prefix))
        .limit(isSvcBucket ? SVC_BUCKET_MAX : 10);

      // P2-11: A random prefix has a huge key space, so natural collisions are
      // vanishingly rare. DoS mitigation: >3 candidates for a *random* prefix
      // is a strong signal of an attacker forcing multiple Argon2 verifications
      // per request, so collapse to the first candidate. The service-account
      // bucket legitimately shares the 'bbam_svc' literal, so it is exempt — we
      // verify every fetched candidate (already bounded by SVC_BUCKET_MAX, ~a
      // few seconds of Argon2 worst-case and itself bounded by the org's real
      // svc-key count; the auth route is rate-limited). The selective-prefix
      // lengthening for new svc keys is the longer-term fix tracked in #40.
      const verifyCandidates =
        !isSvcBucket && candidates.length > 3 ? candidates.slice(0, 1) : candidates;
      if (!isSvcBucket && candidates.length > 3) {
        request.log.warn(
          { prefix, candidate_count: candidates.length },
          'Suspicious number of API key candidates for prefix; limiting to first candidate',
        );
      } else if (isSvcBucket && candidates.length >= SVC_BUCKET_MAX) {
        // At the ceiling a valid key could fall outside the fetched window;
        // this is the signal that the degenerate bucket needs the prefix-
        // lengthening follow-up rather than a higher limit.
        request.log.warn(
          { prefix, candidate_count: candidates.length },
          'Service-account prefix bucket hit SVC_BUCKET_MAX; some keys may not authenticate until prefixes are lengthened (#40 follow-up)',
        );
      }

      for (const candidate of verifyCandidates) {
        // P2-10: Always run argon2.verify BEFORE checking expiry so that
        // expired-but-valid-hash keys and invalid-hash keys take the same
        // amount of wall time. Short-circuiting on expiry first would leak
        // (via timing) whether a given prefix corresponds to a real key.
        // A malformed stored hash throws — treat that as a verification
        // failure so one corrupt row can't 500 every request sharing
        // its prefix.
        let valid = false;
        try {
          valid = await argon2.verify(candidate.apiKey.key_hash, token);
        } catch (err) {
          request.log.warn({ err, api_key_id: candidate.apiKey.id }, 'argon2.verify threw on api key candidate; treating as invalid');
        }
        // Expiry check with rotation grace-period honoring.
        // If the key has been rotated (rotated_at IS NOT NULL) and its
        // rotation_grace_expires_at is still in the future, the predecessor
        // key remains valid during the grace window so callers can roll over
        // without downtime. Once the grace window closes, reject normally.
        const now = new Date();
        if (candidate.apiKey.expires_at && new Date(candidate.apiKey.expires_at) < now) {
          // Key is past its normal expiry. Check grace window.
          if (
            candidate.apiKey.rotated_at &&
            candidate.apiKey.rotation_grace_expires_at &&
            new Date(candidate.apiKey.rotation_grace_expires_at) > now
          ) {
            // Inside grace window -- allow through.
          } else {
            continue;
          }
        }
        if (valid && candidate.user.is_active) {
          // P2-8: pass the key's org_id — for non-SuperUser keys this
          // pins the request's org context to the key's org regardless
          // of what X-Org-Id says or which orgs the user now belongs to.
          request.user = await buildAuthUser(
            candidate.user,
            candidate.apiKey.scope,
            request,
            null,
            candidate.apiKey.org_id,
          );
          // Update last_used_at — fire-and-forget, log errors but don't block the response.
          db.update(apiKeys)
            .set({ last_used_at: new Date() })
            .where(eq(apiKeys.id, candidate.apiKey.id))
            .catch((err) => {
              console.warn('Failed to update api_keys.last_used_at:', err);
            });
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

/** Requires the API key scope to allow the given operation type.
 *  Hierarchy: admin > read_write > read
 *  Session auth (no API key) always passes.
 *  SuperUsers always pass. */
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
    if (request.user.api_key_scope === null) return; // Session auth, no scope restriction

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
  };
}

