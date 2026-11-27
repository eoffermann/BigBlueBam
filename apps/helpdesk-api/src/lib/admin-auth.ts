// Helpdesk admin authorization: one guard for settings.routes.ts,
// users.routes.ts and analytics.routes.ts.
//
// Each of those files used to carry its own requireAdminAuth that only proved
// "a live Bam session (or agent key) exists". The tenant org comes from the
// client-supplied X-Org-Slug header (middleware/resolve-tenant.ts is a pure
// slug-to-id resolver and authorizes nothing), and with no header the
// handlers fell back to an unscoped `LIMIT 1` row or "the first org". So any
// authenticated user of any org could read and rewrite another org's helpdesk
// settings, list its projects, or upsert helpdesk users into it.
//
// This guard:
//   1. resolves the caller (Bam session cookie, else per-agent X-Agent-Key),
//   2. picks the target org: X-Org-Slug if sent, else the caller's own org
//      (the session's active org, else their home org), so header-less
//      callers such as the Bam settings page keep working and get the org
//      they meant instead of an arbitrary one,
//   3. lets platform SuperUsers through,
//   4. otherwise requires membership in the target org. A session caller must
//      also hold the admin or owner org role, mirroring requireScope('admin')
//      in apps/api. An agent key is an operator-issued automation credential
//      (minted with the api CLI), so membership in the org is enough for it.
//
// Roles live in account_group_memberships -> permission_groups.legacy_role.
// helpdesk-api has no Drizzle schema for those tables, so these are raw reads
// against the shared database, as the old guards' session reads were.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { verifyAgentApiKey } from './agent-auth.js';

const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'owner']);

declare module 'fastify' {
  interface FastifyRequest {
    adminUserId?: string;
  }
}

function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

async function sessionCaller(sessionId: string): Promise<{ userId: string; orgId: string | null } | null> {
  const raw = await db.execute(sql`
    SELECT u.id AS user_id, COALESCE(s.active_org_id, u.org_id) AS org_id
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.id = ${sessionId} AND s.expires_at > now() AND u.is_active = true
     LIMIT 1
  `);
  const row = rowsOf(raw)[0];
  return row?.user_id ? { userId: String(row.user_id), orgId: (row.org_id as string | null) ?? null } : null;
}

async function homeOrg(userId: string): Promise<string | null> {
  const row = rowsOf(await db.execute(sql`SELECT org_id FROM users WHERE id = ${userId} LIMIT 1`))[0];
  return (row?.org_id as string | null | undefined) ?? null;
}

async function isSuperuser(userId: string): Promise<boolean> {
  const raw = await db.execute(sql`SELECT 1 AS ok FROM users WHERE id = ${userId} AND is_superuser = true LIMIT 1`);
  return rowsOf(raw).length > 0;
}

/** The caller's org role in orgId: null without an organization_memberships row. */
async function orgRole(userId: string, orgId: string): Promise<{ member: boolean; role: string | null }> {
  const raw = await db.execute(sql`
    SELECT pg.legacy_role AS role
      FROM organization_memberships om
      LEFT JOIN account_group_memberships agm
        ON agm.user_id = om.user_id AND agm.scope_type = 'org' AND agm.scope_id = om.org_id
      LEFT JOIN permission_groups pg ON pg.id = agm.group_id
     WHERE om.user_id = ${userId} AND om.org_id = ${orgId}
     LIMIT 1
  `);
  const row = rowsOf(raw)[0];
  return { member: row !== undefined, role: (row?.role as string | null | undefined) ?? null };
}

export async function requireAdminAuth(request: FastifyRequest, reply: FastifyReply) {
  const deny = (status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });

  let userId: string | null = null;
  let callerOrg: string | null = null;
  let viaAgentKey = false;
  try {
    const sessionCookie = request.cookies?.session;
    if (sessionCookie) {
      const caller = await sessionCaller(sessionCookie);
      if (caller) ({ userId, orgId: callerOrg } = caller);
    }
    if (!userId) {
      userId = await verifyAgentApiKey(request, request.headers['x-agent-key'] as string | undefined);
      viaAgentKey = userId !== null;
      if (userId) callerOrg = await homeOrg(userId);
    }
  } catch (err) {
    request.log.warn({ err }, 'helpdesk requireAdminAuth: caller lookup failed');
    userId = null;
  }
  if (!userId) return deny(401, 'UNAUTHORIZED', 'Authentication required');

  const ctx = request.tenantContext;
  let orgId = ctx?.orgId ?? null;
  if (!orgId) {
    orgId = callerOrg;
    // Publish it so the handlers read a real tenant rather than null.
    if (orgId && ctx) ctx.orgId = orgId;
  }
  if (!orgId) {
    return deny(400, 'ORG_REQUIRED', 'Send an X-Org-Slug header naming the organization to administer');
  }

  if (await isSuperuser(userId)) {
    request.adminUserId = userId;
    return;
  }

  const { member, role } = await orgRole(userId, orgId);
  const allowed = member && (viaAgentKey || (role !== null && ADMIN_ROLES.has(role)));
  if (!allowed) {
    request.log.warn(
      { user_id: userId, target_org_id: orgId, member, role, via_agent_key: viaAgentKey, path: request.url },
      'helpdesk requireAdminAuth: denied, caller is not an admin of the target org',
    );
    return deny(403, 'FORBIDDEN', 'Organization admin privileges required for this organization');
  }
  request.adminUserId = userId;
}
