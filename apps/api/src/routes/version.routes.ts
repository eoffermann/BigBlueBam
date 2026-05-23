import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { requireSuperuser } from '../middleware/require-superuser.js';
import { getVersionInfo, forceVersionCheck } from '../services/version-check.service.js';

export default async function versionRoutes(fastify: FastifyInstance) {
  // GET /version — public, no auth needed
  fastify.get('/version', async () => {
    return { data: await getVersionInfo() };
  });

  // POST /version/check — SuperUser only, forces a fresh check
  // (no catalog permission: /version is in EXCLUDED_PATH_PREFIXES)
  fastify.post(
    '/version/check',
    { preHandler: [requireAuth, requireSuperuser] },
    async () => {
      return { data: await forceVersionCheck() };
    },
  );
}
