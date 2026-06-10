/**
 * Internal service-to-service routes (D-12).
 *
 *   POST /v1/internal/can-read — cross-app read preflight for the Bureau
 *   summon system. bureau-api POSTs { user_id, org_id, target_url } with
 *   X-Internal-Service-Secret before navigating a summon recipient toward
 *   a Brief document; we answer { allowed, can_share } so recipients
 *   without access are quietly filtered (§10 step 3).
 *
 * The decision mirrors middleware/authorize.ts::requireDocumentAccess
 * (private = creator + collaborators, project = project members or
 * collaborators, organization = whole org; org admins/owners and
 * superusers always pass). Keep the two in sync when the visibility
 * model changes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  accountGroupMemberships,
  briefCollaborators,
  briefDocuments,
  permissionGroups,
  projectMemberships,
  users,
} from '../db/schema/index.js';
import { env } from '../env.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const configured = env.INTERNAL_SERVICE_SECRET;
  if (!configured) {
    request.log.warn(
      'INTERNAL_SERVICE_SECRET is not configured — internal routes are unprotected.',
    );
    return;
  }
  const header =
    request.headers['x-internal-service-secret'] ??
    request.headers['x-internal-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !timingSafeStringEqual(provided, configured)) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
  }
}

const canReadBody = z.object({
  user_id: z.string().uuid(),
  org_id: z.string().uuid(),
  target_url: z.string().min(1),
});

/** Extract the document id/slug from a canonical Brief URL (/brief/documents/:id[...]). */
function parseDocumentRefFromUrl(targetUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(targetUrl, 'http://placeholder').pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/brief\/documents\/([^/]+)/);
  return m?.[1] ?? null;
}

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

export default async function internalRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/internal/can-read',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = canReadBody.parse(request.body);

      const deny = (reason: string) =>
        reply.send({ allowed: false, can_share: false, reason });

      const docRef = parseDocumentRefFromUrl(body.target_url);
      if (!docRef) {
        // Not a specific document (home, folders, …) — nothing to protect.
        return reply.send({ allowed: true, can_share: false, reason: 'no_resource' });
      }

      const [user] = await db
        .select({
          id: users.id,
          org_id: users.org_id,
          is_active: users.is_active,
          is_superuser: users.is_superuser,
        })
        .from(users)
        .where(eq(users.id, body.user_id))
        .limit(1);
      if (!user || !user.is_active) return deny('user_not_found');

      const condition = UUID_REGEX.test(docRef)
        ? eq(briefDocuments.id, docRef)
        : eq(briefDocuments.slug, docRef);
      const [doc] = await db
        .select({
          id: briefDocuments.id,
          org_id: briefDocuments.org_id,
          project_id: briefDocuments.project_id,
          visibility: briefDocuments.visibility,
          created_by: briefDocuments.created_by,
        })
        .from(briefDocuments)
        .where(condition)
        .limit(1);
      if (!doc) return deny('not_found');
      if (doc.org_id !== body.org_id) return deny('cross_org');

      if (user.is_superuser) {
        return reply.send({ allowed: true, can_share: true, reason: 'superuser' });
      }

      let role = 'member';
      const [roleRow] = await db
        .select({ legacy_role: permissionGroups.legacy_role })
        .from(accountGroupMemberships)
        .innerJoin(
          permissionGroups,
          eq(permissionGroups.id, accountGroupMemberships.group_id),
        )
        .where(
          and(
            eq(accountGroupMemberships.user_id, user.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, body.org_id),
          ),
        )
        .limit(1);
      if (roleRow?.legacy_role) role = roleRow.legacy_role;

      const isCreator = doc.created_by === user.id;
      const isOrgAdmin = roleLevel(role) >= roleLevel('admin');
      const canShare = isCreator || isOrgAdmin;

      if (isCreator || isOrgAdmin) {
        return reply.send({ allowed: true, can_share: canShare });
      }

      if (doc.visibility === 'organization') {
        return reply.send({ allowed: true, can_share: false });
      }

      const [collab] = await db
        .select({ id: briefCollaborators.id })
        .from(briefCollaborators)
        .where(
          and(
            eq(briefCollaborators.document_id, doc.id),
            eq(briefCollaborators.user_id, user.id),
          ),
        )
        .limit(1);
      if (collab) return reply.send({ allowed: true, can_share: false });

      if (doc.visibility === 'project' && doc.project_id) {
        const [membership] = await db
          .select({ id: projectMemberships.id })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.project_id, doc.project_id),
              eq(projectMemberships.user_id, user.id),
            ),
          )
          .limit(1);
        if (membership) return reply.send({ allowed: true, can_share: false });
      }

      return deny('no_access');
    },
  );
}
