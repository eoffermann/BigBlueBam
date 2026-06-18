/**
 * POST /internal/can-read — cross-app read preflight for the Bureau summon
 * system (D-12).
 *
 * bureau-api's cross-app-access.service.ts POSTs { user_id, org_id,
 * target_url } before navigating a summon recipient toward a Bam resource.
 * We map the URL to a §11 visibility entity (task / project / sprint) and
 * answer through the canonical preflightAccess() in
 * services/visibility.service.ts — the same rules every agent-facing
 * can_access check uses.
 *
 * can_share is always false for Bam targets: "sharing" a task or sprint
 * means changing project membership, which is not a one-click grant the
 * §4.4 dialog should offer. (Board/Brief return real share rights because
 * they have collaborator tables.)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { preflightAccess } from '../services/visibility.service.js';

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

// General (entity_type, entity_id) preflight for internal service callers
// (e.g. the worker's Banter Feed fan-in). Mirrors the public
// /v1/visibility/can_access tool but authenticates with the internal service
// secret instead of a user session, so server-to-server callers don't need a
// per-user credential. Returns the flat PreflightResult shape.
const canAccessBody = z.object({
  asker_user_id: z.string().uuid(),
  entity_type: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(128),
});

/**
 * Map a Bam URL to a §11 visibility entity. Recognized shapes (anywhere
 * under /b3/): .../tasks/:uuid, .../sprints/:uuid, .../projects/:uuid.
 * Most-specific wins so /b3/projects/X/sprints/Y resolves to the sprint.
 */
function parseBamEntityFromUrl(
  targetUrl: string,
): { type: 'bam.task' | 'bam.sprint' | 'bam.project'; id: string } | null {
  let pathname: string;
  try {
    pathname = new URL(targetUrl, 'http://placeholder').pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter(Boolean);
  const findAfter = (label: string): string | null => {
    for (let i = segments.length - 2; i >= 0; i--) {
      const next = segments[i + 1];
      if (segments[i] === label && next && UUID_REGEX.test(next)) {
        return next;
      }
    }
    return null;
  };
  const taskId = findAfter('tasks');
  if (taskId) return { type: 'bam.task', id: taskId };
  const sprintId = findAfter('sprints');
  if (sprintId) return { type: 'bam.sprint', id: sprintId };
  const projectId = findAfter('projects');
  if (projectId) return { type: 'bam.project', id: projectId };
  return null;
}

export default async function internalCanReadRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/internal/can-read',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = canReadBody.parse(request.body);

      const entity = parseBamEntityFromUrl(body.target_url);
      if (!entity) {
        // Board pages, dashboards, list views — nothing entity-scoped to
        // protect beyond org membership, which the summon context implies.
        return reply.send({ allowed: true, can_share: false, reason: 'no_resource' });
      }

      const result = await preflightAccess(body.user_id, entity.type, entity.id);

      // Belt-and-braces org pin: the preflight enforces asker.org ===
      // entity.org; also refuse when the SUMMON's org doesn't match the
      // entity's org (a cross-org summon should never leak existence).
      if (
        result.allowed &&
        result.entity_org_id &&
        result.entity_org_id !== body.org_id
      ) {
        return reply.send({ allowed: false, can_share: false, reason: 'cross_org' });
      }

      return reply.send({
        allowed: result.allowed,
        can_share: false,
        reason: result.reason,
      });
    },
  );

  // POST /internal/visibility/can-access — general (entity_type, entity_id)
  // preflight for internal service callers. Same rules as the agent-facing
  // can_access tool; service-secret auth instead of a user session.
  fastify.post(
    '/internal/visibility/can-access',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = canAccessBody.parse(request.body);
      const result = await preflightAccess(
        body.asker_user_id,
        body.entity_type,
        body.entity_id,
      );
      return reply.send({
        allowed: result.allowed,
        reason: result.reason,
        ...(result.entity_org_id ? { entity_org_id: result.entity_org_id } : {}),
      });
    },
  );
}
