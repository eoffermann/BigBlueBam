/**
 * POST /internal/can-read: cross-app read preflight for Bureau presence and summons (D-12, #300).
 *
 * bureau-api and the worker (through @bigbluebam/shared/cross-app-access) POST
 * { user_id, org_id, target_url } for every suite URL except Board and Brief, which answer for
 * their own. lib/suite-url-entity.ts maps the URL to a section 11 visibility entity (a Bam task,
 * a Bond deal, a Bill invoice, a Helpdesk ticket, ...) and we answer through the canonical
 * preflightAccess() in services/visibility.service.ts, the same rules every can_access check
 * uses. It fails CLOSED: a URL we cannot map (an unknown id, a slug, a name) is denied, never
 * assumed harmless. App homes and list pages (every segment a known page word) are allowed:
 * nothing entity-scoped beyond org membership, which the caller's session implies.
 *
 * can_share is always false here: "sharing" a task or a deal means changing membership, which is
 * not a one-click grant the section 4.4 dialog should offer. (Board/Brief return real share
 * rights because they have collaborator tables.)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalSecret } from '../lib/internal-secret.js';
import { preflightAccess } from '../services/visibility.service.js';
import { suiteUrlEntity } from '../lib/suite-url-entity.js';

// Auth: the shared guard (lib/internal-secret.ts). It fails CLOSED when the secret is unset:
// these routes answer "may this asker see this entity" for a caller-supplied asker_user_id
// verified against no principal, so an unauthenticated request would be an oracle over the
// whole per-user visibility matrix.

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

export default async function internalCanReadRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/internal/can-read',
    { preHandler: [requireInternalSecret] },
    async (request, reply) => {
      const body = canReadBody.parse(request.body);

      const entity = suiteUrlEntity(body.target_url);
      if (entity.kind === 'unsupported') {
        // Fail closed (#300): a URL we cannot judge is never assumed harmless.
        return reply.send({ allowed: false, can_share: false, reason: entity.reason });
      }
      if (entity.kind === 'no_resource') {
        // App homes, list and settings pages: nothing entity-scoped to protect
        // beyond org membership, which the caller's session implies.
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
