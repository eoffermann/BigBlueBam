// SuperUser Deployment Health route.
//
// GET /superuser/config-health feeds the deployment-health banner in the Bam
// SPA. It reports whether the boot secrets are set (never their values) and
// the permission / RLS enforcement posture. The handler reads only this
// process's environment and makes no service-to-service call, so it answers
// on the misconfigured stack it exists to diagnose.
//
// Read-only on purpose: an earlier design also let a SuperUser generate an
// INTERNAL_SERVICE_SECRET into the database, but only the api read it back.
// Every other service's internal-route guard (@bigbluebam/service-health)
// and every caller reads the environment, so a database copy would have been
// a second source of truth the rest of the suite never sees.

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { requirePlatformSuperuser } from '../middleware/require-platform-superuser.js';
import { evaluateConfigHealth } from '../services/config-health.service.js';

export default async function configHealthRoutes(fastify: FastifyInstance) {
  // SuperUser-only in every BBB_PERMISSIONS_ENFORCE posture.
  fastify.addHook('preHandler', requirePlatformSuperuser);

  fastify.get(
    '/superuser/config-health',
    { preHandler: [requireAuth, fastify.requireCan('bam.superuser_config_health.list')] },
    async (_request, reply) => {
      return reply.send({ data: evaluateConfigHealth() });
    },
  );
}
