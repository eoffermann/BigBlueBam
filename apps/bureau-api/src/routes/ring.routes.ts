/**
 * Bureau ring routes (presence-and-immediate-interaction).
 *
 *   POST /v1/ring  — push an incoming-call overlay to a recipient on a
 *                    specific content surface.
 *
 * Body: { to_user_id, surface_app, surface_id, surface_label? }
 * Returns: { data: { ring_token, expires_at, delivered } }
 *
 * Flow:
 *   1. Sender posts the surface they're on plus the recipient.
 *   2. DND check via dnd-check.service.ts. If the recipient has ANY live
 *      session in 'dnd', return 423 RECIPIENT_DND so the UI can offer
 *      "leave a note" instead of silently failing.
 *   3. Publish a 'ring' frame on user:{to_user_id} via ring.service.ts.
 *      The recipient's bureau-client picks it up over WS and shows the
 *      incoming-call overlay.
 *   4. Both sides then mint a surface-huddle token via
 *      POST /v1/surface-huddle/token and meet in LiveKit room
 *      `huddle-{surface_app}-{surface_id}`.
 *
 * Sender authorization: we do NOT cross-app-access-check the surface here
 * for the same reason as POST /v1/surface-huddle/token — the sender knows
 * the surface URL because their own bureau-client mount told us, which
 * means the surface's own app already authorized them onto it.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { badRequest } from '../middleware/room-access.js';
import { isUserInDnd } from '../services/dnd-check.service.js';
import { ringUser } from '../services/ring.service.js';

const SURFACE_APPS = [
  'brief',
  'blueprint',
  'board',
  'bond',
  'bam',
  'beacon',
  'helpdesk',
] as const;

const SURFACE_ID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{0,63})$/;

const ringBody = z.object({
  to_user_id: z.string().uuid(),
  surface_app: z.enum(SURFACE_APPS),
  surface_id: z.string().regex(SURFACE_ID_REGEX, 'Invalid surface_id'),
  surface_label: z.string().max(255).optional(),
});

export default async function ringRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/ring',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = ringBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const { to_user_id, surface_app, surface_id, surface_label } = parsed.data;

      // Self-ring is meaningless; the overlay would pop on the sender's
      // own device. Reject early so the UI can collapse the action.
      if (to_user_id === user.id) {
        return badRequest(request, reply, 'You cannot ring yourself');
      }

      // §4.3-style DND check. Any live session of the recipient in 'dnd'
      // blocks the ring with 423; the UI surfaces a "leave a note" affordance
      // that drops back to the existing Banter DM path.
      const recipientInDnd = await isUserInDnd(fastify.redis, to_user_id);
      if (recipientInDnd) {
        return reply.status(423).send({
          error: {
            code: 'RECIPIENT_DND',
            message: 'Recipient is currently in Do Not Disturb',
            details: [],
            request_id: request.id,
            recipient_dnd: true,
          },
        });
      }

      const result = await ringUser(
        fastify.redis,
        user.id,
        user.display_name,
        to_user_id,
        surface_app,
        surface_id,
        surface_label ?? null,
      );

      return reply.status(200).send({ data: result });
    },
  );
}
