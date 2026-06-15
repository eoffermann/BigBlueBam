import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as userSettingsService from '../services/user-settings.service.js';

/**
 * Per-user Bond settings. These are the caller's OWN settings (keyed on the
 * authenticated user id), so no per-action permission is required beyond a
 * valid session; the PATCH still requires a read_write API-key scope.
 */
export default async function userSettingsRoutes(fastify: FastifyInstance) {
  // GET /user-settings — the current user's Bond settings.
  fastify.get('/user-settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const settings = await userSettingsService.getUserSettings(request.user!.id);
    return reply.send({ data: settings });
  });

  // PATCH /user-settings — set/clear the reply-to address.
  fastify.patch(
    '/user-settings',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = z
        .object({
          // A valid email, or an empty string / null to clear it.
          reply_to_email: z
            .union([z.string().email().max(255), z.literal(''), z.null()])
            .optional(),
        })
        .parse(request.body);

      const replyTo =
        body.reply_to_email === '' || body.reply_to_email === undefined
          ? null
          : body.reply_to_email;

      const settings = await userSettingsService.updateUserSettings(request.user!.id, {
        reply_to_email: replyTo,
      });
      return reply.send({ data: settings });
    },
  );
}
