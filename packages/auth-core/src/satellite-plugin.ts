// The satellite services' authentication plugin, once (#369).
//
// Every *-api satellite (banter-api, bond-api, ..., bursar-api) authenticates the same three
// ways, and each used to carry its own ~275-line copy of the plugin that did it:
//
//   1. a Bam session cookie (`session`): sessions JOIN users, unexpired, owner active;
//   2. a bbam_ API key (`Authorization: Bearer`): verifyApiKeyToken, a project-restricted key
//      refused (#352), the P2-8 org pin (the key's own org and the holder's current role there,
//      X-Org-Id dropped), and last_used_at bumped;
//   3. SuperUser impersonation (`X-Impersonate-User`): only a SuperUser, only an active,
//      non-SuperUser target, and only while an unexpired, un-ended impersonation_sessions row
//      exists for the (SuperUser, target) pair, created by POST /v1/platform/impersonate on
//      the Bam api. Fail closed.
//
// A fix that landed in some copies and not the rest is how #91, #340 and #350 happened, so the
// step order and the session/impersonation rules live here, and each service's
// plugins/auth.ts is a binding: its db.execute, drizzle sql tag, argon2, and the two per-service
// options below. scripts/lib/auth-core-single-source.test.mjs fails a satellite plugin that
// grows its own session or impersonation logic again.
//
// Per-service options (the only intentional differences between the old copies):
//   - sessionActiveOrg: honor sessions.active_org_id (the org Bam's /auth/switch-org last chose)
//     for cookie auth, after X-Org-Id and before the default membership. banter-api, bolt-api.
//   - superuserMayViewAnyOrg: a SuperUser may act in any live org it is not a member of, with
//     SUPERUSER_VIEWING_ROLE. banter-api.
//
// request.user and friends are typed for a service by importing
// '@bigbluebam/auth-core/fastify-request' (a separate entry so apps/api, whose request.user has
// a different shape, never sees the augmentation).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type ApiKeyStore,
  bearerToken,
  isApiKeyOrgPinned,
  resolveKeyOrgPin,
  sqlApiKeyStore,
  type UserKind,
  verifyApiKeyToken,
} from './index.js';
import { refuseProjectRestrictedKey } from './key-project.js';
import {
  type OrgContextStore,
  type OrgMembership,
  OrgMembershipError,
  requestedOrgIdFromHeader,
  resolveOrgContext,
  sqlOrgContextStore,
} from './org-context.js';
import { rowsOf } from './rows.js';

/** request.user on every satellite service. */
export interface SatelliteAuthUser {
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
  kind?: UserKind;
  api_key_scope: string | null;
  org_memberships: OrgMembership[];
  active_org_id: string;
}

/** The users columns an AuthUser is built from. */
export interface SatelliteUserRow {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string;
  is_active: boolean;
  is_superuser: boolean;
}

export interface SatelliteSessionRow {
  expires_at: Date;
  active_org_id: string | null;
  user: SatelliteUserRow;
}

/** Session and impersonation reads. sqlSatelliteAuthStore() builds one from sql + db.execute. */
export interface SatelliteAuthStore {
  /** The session row with this id joined to its user, whatever its expiry or user state. */
  findSession(sessionId: string): Promise<SatelliteSessionRow | null>;
  findUser(userId: string): Promise<SatelliteUserRow | null>;
  /** An unexpired, un-ended impersonation_sessions row exists for (superuser, target). */
  hasActiveImpersonation(superuserId: string, targetUserId: string): Promise<boolean>;
}

export interface SqlSatelliteAuthStoreDeps {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any drizzle sql tag signature
  sql: (strings: TemplateStringsArray, ...values: any[]) => unknown;
  execute: (query: never) => Promise<unknown>;
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function userFromRow(r: Record<string, unknown>, prefix = ''): SatelliteUserRow {
  const s = (k: string) => {
    const v = r[`${prefix}${k}`];
    return v === null || v === undefined ? '' : String(v);
  };
  return {
    id: s('id'),
    org_id: s('org_id'),
    email: s('email'),
    display_name: s('display_name'),
    avatar_url: (r[`${prefix}avatar_url`] as string | null | undefined) ?? null,
    timezone: s('timezone'),
    is_active: r[`${prefix}is_active`] === true,
    is_superuser: r[`${prefix}is_superuser`] === true,
  };
}

/** The SQL store every satellite uses: the shared DB's sessions, users, impersonation_sessions. */
export function sqlSatelliteAuthStore(deps: SqlSatelliteAuthStoreDeps): SatelliteAuthStore {
  const tag = deps.sql;
  const execute = deps.execute as (query: unknown) => Promise<unknown>;
  return {
    async findSession(sessionId) {
      const [r] = rowsOf(
        await execute(tag`
          SELECT s.expires_at, s.active_org_id,
                 u.id AS u_id, u.org_id AS u_org_id, u.email AS u_email,
                 u.display_name AS u_display_name, u.avatar_url AS u_avatar_url,
                 u.timezone AS u_timezone, u.is_active AS u_is_active,
                 u.is_superuser AS u_is_superuser
            FROM sessions s
            JOIN users u ON u.id = s.user_id
           WHERE s.id = ${sessionId}
           LIMIT 1`),
      );
      if (!r) return null;
      return {
        expires_at: toDate(r.expires_at),
        active_org_id: (r.active_org_id as string | null | undefined) ?? null,
        user: userFromRow(r, 'u_'),
      };
    },
    async findUser(userId) {
      const [r] = rowsOf(
        await execute(tag`
          SELECT id, org_id, email, display_name, avatar_url, timezone, is_active, is_superuser
            FROM users
           WHERE id = ${userId}::uuid
           LIMIT 1`),
      );
      return r ? userFromRow(r) : null;
    },
    async hasActiveImpersonation(superuserId, targetUserId) {
      const rows = rowsOf(
        await execute(tag`
          SELECT 1 AS ok
            FROM impersonation_sessions
           WHERE superuser_id = ${superuserId}::uuid
             AND target_user_id = ${targetUserId}::uuid
             AND ended_at IS NULL
             AND expires_at > now()
           LIMIT 1`),
      );
      return rows.length > 0;
    },
  };
}

export interface SatelliteAuthOptions {
  /** The service's drizzle `sql` tag. */
  // biome-ignore lint/suspicious/noExplicitAny: accepts any drizzle sql tag signature
  sql: (strings: TemplateStringsArray, ...values: any[]) => unknown;
  /** The service's `db.execute`. */
  execute: (query: never) => Promise<unknown>;
  /** argon2.verify (the service's own argon2 dependency). */
  verifyHash: (hash: string, token: string) => Promise<boolean>;
  /** Honor sessions.active_org_id for cookie auth (banter-api, bolt-api). Default false. */
  sessionActiveOrg?: boolean;
  /** A SuperUser may act in any live org (banter-api). Default false. */
  superuserMayViewAnyOrg?: boolean;
  /** Test seams: replace a SQL-backed store. */
  stores?: { auth?: SatelliteAuthStore; apiKeys?: ApiKeyStore; orgContext?: OrgContextStore };
  /** Clock for the session expiry check. */
  now?: () => Date;
}

export interface SatelliteAuth {
  /** The Fastify plugin. Wrap it with fastify-plugin as { name: 'auth', dependencies: ['@fastify/cookie'] }. */
  plugin: (fastify: FastifyInstance) => Promise<void>;
  /**
   * Build request.user for a users row. `apiKeyOrgId` applies the P2-8 pin (X-Org-Id is then
   * ignored, and the key's org and the holder's current role there win); `sessionActiveOrgId`
   * is honored only when the service opted into sessionActiveOrg.
   */
  buildAuthUser(
    row: SatelliteUserRow,
    apiKeyScope: string | null,
    request: FastifyRequest,
    apiKeyOrgId?: string | null,
    sessionActiveOrgId?: string | null,
  ): Promise<SatelliteAuthUser>;
  requireAuth: typeof requireAuthenticated;
}

interface SatelliteRequest {
  user: SatelliteAuthUser | null;
  sessionId: string | null;
  impersonator: SatelliteAuthUser | null;
  isImpersonating: boolean;
  cookies?: Record<string, string | undefined>;
}

const sat = (request: FastifyRequest) => request as unknown as SatelliteRequest;

function sendError(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
}

/** preHandler: 401 unless the auth plugin resolved a user. */
export async function requireAuthenticated(request: FastifyRequest, reply: FastifyReply) {
  if (!sat(request).user) {
    return sendError(request, reply, 401, 'UNAUTHORIZED', 'Authentication required');
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function impersonateHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-impersonate-user'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

export function createSatelliteAuth(opts: SatelliteAuthOptions): SatelliteAuth {
  const deps = { sql: opts.sql, execute: opts.execute };
  const authStore = opts.stores?.auth ?? sqlSatelliteAuthStore(deps);
  const apiKeyStore = opts.stores?.apiKeys ?? sqlApiKeyStore({ ...deps, verifyHash: opts.verifyHash });
  // Memberships, roles and org liveness through migration 0311's identity functions, so
  // soft-deleted orgs never resolve and the reads work before any org is bound (#350).
  const orgContextStore = opts.stores?.orgContext ?? sqlOrgContextStore(deps);
  const now = opts.now ?? (() => new Date());

  const buildAuthUser: SatelliteAuth['buildAuthUser'] = async (
    row,
    apiKeyScope,
    request,
    apiKeyOrgId = null,
    sessionActiveOrgId = null,
  ) => {
    // P2-8: a pinned key's X-Org-Id is ignored outright, not validated: resolving it would
    // throw OrgMembershipError (403) for an org the user is not in, which is a membership probe.
    const pinned = isApiKeyOrgPinned(apiKeyOrgId, row.is_superuser);
    const requestedOrgId = pinned ? undefined : requestedOrgIdFromHeader(request.headers['x-org-id']);
    const { memberships, activeOrgId, activeRole } = await resolveOrgContext(
      orgContextStore,
      row.id,
      row.org_id,
      requestedOrgId,
      {
        sessionActiveOrgId: opts.sessionActiveOrg ? sessionActiveOrgId : null,
        isSuperuser: row.is_superuser,
        superuserMayViewAnyOrg: opts.superuserMayViewAnyOrg === true,
      },
    );
    // The key's org and the holder's CURRENT role there ('viewer' once they left it), so losing
    // membership strips role-derived privilege. Memberships stay resolved in full above.
    const pin = pinned ? resolveKeyOrgPin(apiKeyOrgId, row.is_superuser, memberships) : null;
    const orgId = pin?.orgId ?? activeOrgId;
    return {
      id: row.id,
      org_id: orgId,
      email: row.email,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      role: pin?.role ?? activeRole,
      timezone: row.timezone,
      is_active: row.is_active,
      is_superuser: row.is_superuser,
      api_key_scope: apiKeyScope,
      org_memberships: memberships,
      active_org_id: orgId,
    };
  };

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const req = sat(request);
    try {
      const sessionId = req.cookies?.session;
      if (sessionId) {
        const session = await authStore.findSession(sessionId);
        if (session && session.expires_at > now() && session.user.is_active) {
          req.user = await buildAuthUser(session.user, null, request, null, session.active_org_id);
          req.sessionId = sessionId;
          return;
        }
      }

      // Bearer API key. Verification (expiry, rotation grace, DoS caps, owner state) is
      // verifyApiKeyToken's and requireScope is the shared gate (#340).
      const token = bearerToken(request.headers.authorization);
      const verified = token ? await verifyApiKeyToken(token, apiKeyStore, request.log) : null;
      if (verified) {
        // #352: no Bam project context here to confine a project-restricted key to.
        const restricted = refuseProjectRestrictedKey(request, reply, verified.apiKey.project_ids);
        if (restricted) return restricted;
        // P2-8: downstream code must not see a header the pin overrode either.
        if (isApiKeyOrgPinned(verified.apiKey.org_id, verified.user.is_superuser)) {
          request.headers['x-org-id'] = undefined;
        }
        const user = await buildAuthUser(verified.user, verified.apiKey.scope, request, verified.apiKey.org_id);
        user.kind = verified.user.kind;
        req.user = user;
        apiKeyStore.touch(verified.apiKey.id).catch((err: unknown) => {
          request.log.warn({ err }, 'Failed to update api_keys.last_used_at');
        });
      }
    } catch (err) {
      if (err instanceof OrgMembershipError) {
        return sendError(request, reply, 403, 'FORBIDDEN', err.message);
      }
      throw err;
    }
  }

  // Runs after authenticate: only a SuperUser, only with an active impersonation session.
  async function impersonate(request: FastifyRequest) {
    const req = sat(request);
    const header = impersonateHeader(request);
    if (!header || header.length !== 36 || !UUID_REGEX.test(header)) return;
    const impersonator = req.user;
    if (!impersonator || impersonator.is_superuser !== true) return;
    if (header === impersonator.id) return;

    const target = await authStore.findUser(header);
    if (!target || !target.is_active || target.is_superuser) return;
    if (!(await authStore.hasActiveImpersonation(impersonator.id, target.id))) return;

    req.impersonator = impersonator;
    req.user = await buildAuthUser(target, null, request);
    req.isImpersonating = true;
  }

  async function plugin(fastify: FastifyInstance) {
    fastify.decorateRequest('user', null);
    fastify.decorateRequest('sessionId', null);
    fastify.decorateRequest('impersonator', null);
    fastify.decorateRequest('isImpersonating', false);
    fastify.addHook('preHandler', authenticate);
    fastify.addHook('preHandler', impersonate);
    fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply) => {
      const req = sat(request);
      if (req.isImpersonating && req.impersonator) {
        reply.header('X-Impersonating', 'true');
        reply.header('X-Impersonator', req.impersonator.id);
      }
    });
  }

  return { plugin, buildAuthUser, requireAuth: requireAuthenticated };
}
