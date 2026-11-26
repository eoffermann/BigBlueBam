import type { FastifyInstance } from 'fastify';
import { bastionCompanyProfileSchema, bastionSetupComplianceProjectSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { handled, validationError, viewerOf } from '../lib/http.js';
import * as setup from '../services/setup.service.js';

// The Setup wizard's own routes (spec 6.1 /bastion/setup). Not rows of spec 5.1; recorded in
// the surface map with the M3 parity decision (read has a tool, the writes are human setup acts).
export default async function setupRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/setup', { preHandler: [requireAuth, can('bastion.framework.read')] }, async (request, reply) =>
    handled(request, reply, () => setup.getSetup(viewerOf(request))),
  );

  fastify.patch('/setup/profile', { preHandler: [requireAuth, can('bastion.framework.write')] }, async (request, reply) => {
    const parsed = bastionCompanyProfileSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => setup.saveCompanyProfile(viewerOf(request), parsed.data));
  });

  fastify.post(
    '/setup/compliance-project',
    { preHandler: [requireAuth, can('bastion.framework.write')] },
    async (request, reply) => {
      const parsed = bastionSetupComplianceProjectSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => setup.setComplianceProject(viewerOf(request), parsed.data));
    },
  );
}
