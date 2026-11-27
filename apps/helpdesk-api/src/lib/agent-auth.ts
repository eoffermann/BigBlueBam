import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { carriesInternalToken, createInternalSecretGuard } from '@bigbluebam/service-health';
import { scopeAtLeast } from '@bigbluebam/auth-core';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { helpdeskAgentApiKeys } from '../db/schema/helpdesk-agent-api-keys.js';
import { users } from '../db/schema/bbb-refs.js';
import { bamBearerToken, verifyBamApiKey } from './bam-api-key.js';

/**
 * Agent-surface authentication for /helpdesk/agents/* (agent.routes.ts and
 * dedupe.routes.ts). One guard, so every agent route accepts the same
 * credentials:
 *
 *  1. Bam-proxied call: X-Internal-Token (INTERNAL_HELPDESK_SECRET) plus the
 *     acting user and org Bam already authenticated (apps/api
 *     internal-helpdesk.routes.ts).
 *  2. Bam API key as `Authorization: Bearer bbam_...` (#339): the credential
 *     the MCP server forwards for every tool call. Verified by
 *     lib/bam-api-key.ts (the same rules as apps/api and the #325 admin
 *     guard), pinned to the key's org, and the owner must belong to that org
 *     (or be a SuperUser). A 'read' key may only read; writes need
 *     'read_write' or 'admin', mirroring requireScope('read_write') in apps/api.
 *     Only bbam_-prefixed tokens are taken, so the customer portal's own
 *     credentials can never be mistaken for one.
 *  3. Per-agent helpdesk key in X-Agent-Key (HB-28 + HB-49). A Bam session
 *     cookie sent alongside must belong to the key's owner (403 otherwise,
 *     #173); it then fixes the org to the session's active org.
 *
 * On success request.agentUserId is the acting Bam user, and request.agentOrgId
 * is set when the credential fixes the org (1 and 2). resolveAgentRequestOrgId
 * gives every handler the org to scope by.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Bam user id of the authenticated agent (set by requireAgentAuth). */
    agentUserId: string | null;
    /**
     * Org the request acts in when the credential fixes it: a Bam-proxied call
     * (X-Acting-Org-Id) or a Bam API key (its pinned org). Takes precedence over
     * every other org source.
     */
    agentOrgId: string | null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

function deny(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
}

/**
 * Verify a per-agent helpdesk API key (HB-28 + HB-49).
 *
 *  - Token prefix (first 8 chars) indexes into helpdesk_agent_api_keys;
 *    full token is Argon2id-verified against key_hash.
 *  - DoS mitigation: cap candidate verifications if a prefix has >3
 *    candidates (natural prefix collisions are vanishingly rare with
 *    an 8-char random prefix).
 *  - Always run argon2.verify before checking revoked/expired so timing
 *    doesn't leak whether a prefix corresponds to a live key.
 *
 * Returns the Bam user_id owning the key on success, or null on any
 * verification failure.
 */
export async function verifyAgentApiKey(
  request: FastifyRequest,
  token: string | undefined,
): Promise<string | null> {
  if (!token || token.length < 9) return null;

  const prefix = token.slice(0, 8);

  const candidates = await db
    .select({
      id: helpdeskAgentApiKeys.id,
      bbb_user_id: helpdeskAgentApiKeys.bbb_user_id,
      key_hash: helpdeskAgentApiKeys.key_hash,
      expires_at: helpdeskAgentApiKeys.expires_at,
      revoked_at: helpdeskAgentApiKeys.revoked_at,
      user_is_active: users.is_active,
    })
    .from(helpdeskAgentApiKeys)
    .innerJoin(users, eq(users.id, helpdeskAgentApiKeys.bbb_user_id))
    .where(eq(helpdeskAgentApiKeys.key_prefix, prefix))
    .limit(10);

  const verifyCandidates = candidates.length > 3 ? candidates.slice(0, 1) : candidates;
  if (candidates.length > 3) {
    request.log.warn(
      { prefix, candidate_count: candidates.length },
      'Suspicious number of helpdesk agent key candidates for prefix; limiting to first candidate',
    );
  }

  const now = new Date();
  for (const candidate of verifyCandidates) {
    // A malformed stored hash throws; treat that as a verification
    // failure so one corrupt row can't 500 every request that happens
    // to share its prefix.
    let valid = false;
    try {
      valid = await argon2.verify(candidate.key_hash, token);
    } catch (err) {
      request.log.warn({ err, candidate_id: candidate.id }, 'argon2.verify threw on agent key candidate; treating as invalid');
    }
    if (!valid) continue;
    if (candidate.revoked_at && new Date(candidate.revoked_at) <= now) continue;
    if (candidate.expires_at && new Date(candidate.expires_at) <= now) continue;
    if (!candidate.user_is_active) continue;

    // Fire-and-forget last_used_at update; don't block the response.
    db.update(helpdeskAgentApiKeys)
      .set({ last_used_at: now })
      .where(eq(helpdeskAgentApiKeys.id, candidate.id))
      .catch((err) => {
        request.log.warn({ err }, 'Failed to update helpdesk_agent_api_keys.last_used_at');
      });

    return candidate.bbb_user_id;
  }

  return null;
}

/** Bam-proxied agent calls: X-Internal-Token keyed by INTERNAL_HELPDESK_SECRET (HB-7). */
const checkHelpdeskToken = createInternalSecretGuard({
  secrets: () => [env.INTERNAL_HELPDESK_SECRET],
  tokenHeaderOnly: true,
});

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Bam-proxied agent call. Returns true when the request was handled
 * (authorized, or a reply was sent); false when no internal token is present.
 */
async function tryInternalProxyAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!carriesInternalToken(request)) return false;

  // The suite-wide guard (#252, #306, @bigbluebam/service-health): constant-time compare against
  // INTERNAL_HELPDESK_SECRET, fail closed, direct private-network peer only. Bam's api calls here
  // directly at HELPDESK_API_URL, never through the edge nginx.
  if (!checkHelpdeskToken(request, reply)) return true;

  const actingUserId = headerValue(request, 'x-acting-user-id');
  const actingOrgId = headerValue(request, 'x-acting-org-id');
  if (!actingUserId || !actingOrgId || !UUID_RE.test(actingUserId) || !UUID_RE.test(actingOrgId)) {
    deny(request, reply, 401, 'UNAUTHORIZED', 'Internal agent calls must name the acting user and org');
    return true;
  }

  if (!(await isActiveMemberOrSuperuser(actingUserId, actingOrgId))) {
    deny(request, reply, 401, 'UNAUTHORIZED', 'Acting user is not an active member of the acting org');
    return true;
  }

  request.agentUserId = actingUserId;
  request.agentOrgId = actingOrgId;
  return true;
}

/** The user exists, is active, and belongs to orgId (or is a SuperUser, who may act in any org). */
async function isActiveMemberOrSuperuser(userId: string, orgId: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT u.id
        FROM users u
        WHERE u.id = ${userId}
          AND u.is_active = true
          AND (
            u.is_superuser = true
            OR EXISTS (
              SELECT 1 FROM organization_memberships m
              WHERE m.user_id = u.id AND m.org_id = ${orgId}
            )
          )
        LIMIT 1`,
  );
  return rowsOf(result).length > 0;
}

async function homeOrg(userId: string): Promise<string | null> {
  const row = rowsOf(await db.execute(sql`SELECT org_id FROM users WHERE id = ${userId} LIMIT 1`))[0];
  return (row?.org_id as string | null | undefined) ?? null;
}

/**
 * Bam API key as Bearer (#339). Returns true when handled (authorized, or a
 * reply was sent); false when the request carries no bbam_ Bearer token.
 */
async function tryBamBearerAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = bamBearerToken(request);
  if (!token) return false;

  const caller = await verifyBamApiKey(request, token);
  if (!caller) {
    deny(request, reply, 401, 'UNAUTHORIZED', 'Invalid or expired API key');
    return true;
  }

  const isRead = request.method === 'GET' || request.method === 'HEAD';
  if (!isRead && !scopeAtLeast(caller.scope, 'read_write')) {
    deny(request, reply, 403, 'FORBIDDEN', "API key requires at least 'read_write' scope");
    return true;
  }

  // API keys are pinned to one org (P2-8 in apps/api); a legacy key with no
  // org acts in its owner's home org.
  const orgId = caller.keyOrgId ?? (await homeOrg(caller.userId));
  if (!orgId || !(await isActiveMemberOrSuperuser(caller.userId, orgId))) {
    deny(request, reply, 403, 'FORBIDDEN', 'API key owner is not a member of the key organization');
    return true;
  }

  request.agentUserId = caller.userId;
  request.agentOrgId = orgId;
  return true;
}

/** Fastify preHandler for every /helpdesk/agents/* route. */
export async function requireAgentAuth(request: FastifyRequest, reply: FastifyReply) {
  request.agentUserId = null;
  request.agentOrgId = null;

  if (await tryInternalProxyAuth(request, reply)) return;
  if (await tryBamBearerAuth(request, reply)) return;

  const token = request.headers['x-agent-key'] as string | undefined;
  if (!token || token.length < 9) {
    return deny(request, reply, 401, 'UNAUTHORIZED', 'Missing or malformed X-Agent-Key header');
  }
  const userId = await verifyAgentApiKey(request, token);
  if (!userId) {
    return deny(request, reply, 401, 'UNAUTHORIZED', 'Invalid agent API key');
  }

  // #173: a Bam session cookie that accompanies an X-Agent-Key must belong to
  // the key's owner. Before this, key X plus user Y's session read Y's org and
  // posted as Y. A matching session fixes the org to the session's ACTIVE org
  // (the org the user switched to in Bam), not the user's home org.
  const sessionCookie = request.cookies?.session;
  if (sessionCookie) {
    const session = await liveSession(sessionCookie);
    if (session) {
      if (session.userId !== userId) {
        return deny(
          request,
          reply,
          403,
          'AGENT_SESSION_MISMATCH',
          'The agent key and the Bam session belong to different users',
        );
      }
      const orgId = session.activeOrgId ?? session.homeOrgId;
      if (!orgId || !(await isActiveMemberOrSuperuser(userId, orgId))) {
        return deny(request, reply, 403, 'FORBIDDEN', 'Session user is not a member of the active organization');
      }
      request.agentOrgId = orgId;
    }
  }
  request.agentUserId = userId;
}

/** A live (unexpired) Bam session: its user, active org, and the user's home org. Null when absent. */
async function liveSession(
  sessionId: string,
): Promise<{ userId: string; activeOrgId: string | null; homeOrgId: string | null } | null> {
  const row = rowsOf(
    await db.execute(
      sql`SELECT s.user_id AS user_id, s.active_org_id AS active_org_id, u.org_id AS org_id
          FROM sessions s
          JOIN users u ON u.id = s.user_id
          WHERE s.id = ${sessionId} AND s.expires_at > now()
          LIMIT 1`,
    ),
  )[0];
  if (!row?.user_id) return null;
  return {
    userId: String(row.user_id),
    activeOrgId: row.active_org_id ? String(row.active_org_id) : null,
    homeOrgId: row.org_id ? String(row.org_id) : null,
  };
}

/**
 * The org an authenticated agent request is scoped to: the org the credential
 * fixed (Bam proxy, Bam API key, or the key owner's own Bam session's active
 * org, all set by requireAgentAuth), else the X-Agent-Key owner's home org.
 * Null only if no source yields one.
 */
export async function resolveAgentRequestOrgId(request: FastifyRequest): Promise<string | null> {
  if (request.agentOrgId) return request.agentOrgId;
  if (!request.agentUserId) return null;
  try {
    const [row] = await db
      .select({ org_id: users.org_id })
      .from(users)
      .where(eq(users.id, request.agentUserId))
      .limit(1);
    return (row?.org_id as string | null) ?? null;
  } catch {
    return null;
  }
}
