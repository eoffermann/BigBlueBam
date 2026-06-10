/**
 * Internal service-to-service routes (D-12).
 *
 *   POST /v1/internal/can-read — cross-app read preflight for the Bureau
 *   summon system. bureau-api's cross-app-access.service.ts POSTs
 *   { user_id, org_id, target_url } with X-Internal-Service-Secret before
 *   navigating a summon recipient toward a Board canvas; we answer
 *   { allowed, can_share } so recipients without access are quietly
 *   filtered (§10 step 3) and the §4.4 grant dialog knows whether the
 *   summoner can share.
 *
 * The visibility decision mirrors middleware/authorize.ts::requireBoardAccess
 * (private = creator + collaborators, project = project members or
 * collaborators, organization = whole org; org admins/owners and
 * superusers always pass). It is re-stated here as a pure function because
 * the middleware is welded to request/reply and a live session — keep the
 * two in sync when the visibility model changes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  accountGroupMemberships,
  boardCollaborators,
  boards,
  permissionGroups,
  projectMembers,
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

/** Extract the board id from a canonical Board URL (/board/:id[...]). */
function parseBoardIdFromUrl(targetUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(targetUrl, 'http://placeholder').pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/^\/board\/([^/]+)/);
  if (!m || !m[1]) return null;
  return UUID_REGEX.test(m[1]) ? m[1] : null;
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

      const boardId = parseBoardIdFromUrl(body.target_url);
      if (!boardId) {
        // Not a specific canvas (list/template pages) — nothing to protect.
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

      const [board] = await db
        .select({
          id: boards.id,
          organization_id: boards.organization_id,
          project_id: boards.project_id,
          visibility: boards.visibility,
          created_by: boards.created_by,
        })
        .from(boards)
        .where(eq(boards.id, boardId))
        .limit(1);
      if (!board) return deny('not_found');
      if (board.organization_id !== body.org_id) return deny('cross_org');

      if (user.is_superuser) {
        return reply.send({ allowed: true, can_share: true, reason: 'superuser' });
      }

      // Org role for THIS org via the permission-group bridge (same source
      // the auth plugin uses; default 'member' when no group row exists).
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

      const isCreator = board.created_by === user.id;
      const isOrgAdmin = roleLevel(role) >= roleLevel('admin');
      // Share rights drive the §4.4 grant-and-summon dialog: creator and
      // org admins/owners can add collaborators.
      const canShare = isCreator || isOrgAdmin;

      if (isCreator || isOrgAdmin) {
        return reply.send({ allowed: true, can_share: canShare });
      }

      if (board.visibility === 'organization') {
        // The cross_org check above already pinned the board to the org the
        // summon is happening in; membership of that org is implied by the
        // summon context.
        return reply.send({ allowed: true, can_share: false });
      }

      const [collab] = await db
        .select({ id: boardCollaborators.id })
        .from(boardCollaborators)
        .where(
          and(
            eq(boardCollaborators.board_id, board.id),
            eq(boardCollaborators.user_id, user.id),
          ),
        )
        .limit(1);
      if (collab) return reply.send({ allowed: true, can_share: false });

      if (board.visibility === 'project' && board.project_id) {
        const [membership] = await db
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.project_id, board.project_id),
              eq(projectMembers.user_id, user.id),
            ),
          )
          .limit(1);
        if (membership) return reply.send({ allowed: true, can_share: false });
      }

      return deny('no_access');
    },
  );
}
