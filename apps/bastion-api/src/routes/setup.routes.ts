import type { FastifyInstance } from 'fastify';
import { bastionCompanyProfileSchema, bastionSetupComplianceProjectSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { handled, validationError, viewerOf } from '../lib/http.js';
import * as setup from '../services/setup.service.js';
import { orgTx } from '../engine/context.js';
import { redriveProjectDeliveries } from '../engine/remediation.js';
import { engineDeps } from '../engine/runtime.js';

// The Setup wizard's own routes (spec 6.1 /bastion/setup). Not rows of spec 5.1; recorded in
// the surface map; each has a pending MCP tool (bastion_get_setup_status, and per the #196
// decision bastion_save_company_profile and bastion_set_compliance_project).
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
      const viewer = viewerOf(request);
      return handled(request, reply, async () => {
        const out = await setup.setComplianceProject(viewer, parsed.data);
        // #229: tasks that died on the old (deleted or phase-less) project are filed now. Best
        // effort: the next outbox drain re-drives them anyway.
        try {
          const sql = engineDeps(fastify.log, fastify.redis).sql;
          await orgTx(sql, viewer.org_id, (tx) => redriveProjectDeliveries(tx, viewer.org_id));
        } catch (err) {
          request.log.warn({ err }, 'bastion setup: re-driving waiting task deliveries failed; the next outbox drain retries');
        }
        return out;
      });
    },
  );
}
