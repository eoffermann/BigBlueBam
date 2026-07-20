import type { FastifyInstance } from 'fastify';
import { bursarSettingsUpdateSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, requireOrgAdmin, validationError, viewerOf } from '../lib/http.js';
import * as settings from '../services/settings.service.js';

// Per-route permission metadata authored inline (spec 13.3). PATCH carries a SECOND,
// independent in-route org-admin guard (requireOrgAdmin) on top of bursar.settings.write:
// weakening a detector weight is the consequential direction, and this guard reads the role
// directly off request.user so a permission-resolver outage cannot open it. EVERY settings
// write produces an audited before/after diff (spec 5.6).
export default async function settingsRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/settings',
    { preHandler: [requireAuth, can('bursar.settings.read')] },
    async (request) => settings.getSettings(viewerOf(request)),
  );

  fastify.get(
    '/settings/audit',
    { preHandler: [requireAuth, can('bursar.settings.read')] },
    async (request) => settings.listSettingsAudit(viewerOf(request)),
  );

  fastify.patch(
    '/settings',
    { preHandler: [requireAuth, can('bursar.settings.write'), requireOrgAdmin] },
    async (request, reply) => {
      const parsed = bursarSettingsUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return await settings.updateSettings(viewerOf(request), parsed.data);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
