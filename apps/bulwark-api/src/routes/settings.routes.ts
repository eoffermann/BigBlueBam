import type { FastifyInstance } from 'fastify';
import { bulwarkUpdateSettingsSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import * as settings from '../services/settings.service.js';

export default async function settingsRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/settings',
    { preHandler: [requireAuth, can('bulwark.settings.read')] },
    async (request) => {
      const data = await settings.getSettings(request.user!.org_id);
      return { data };
    },
  );

  fastify.patch(
    '/settings',
    { preHandler: [requireAuth, can('bulwark.settings.write')] },
    async (request, reply) => {
      const parsed = bulwarkUpdateSettingsSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const data = await settings.updateSettings(
          viewerOf(request).org_id,
          viewerOf(request).id,
          parsed.data,
        );
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
