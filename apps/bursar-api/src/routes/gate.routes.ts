import type { FastifyInstance } from 'fastify';
import { bursarScopeGapSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { validationError, viewerOf } from '../lib/http.js';
import * as gate from '../services/gate.service.js';

// Advisory scope-gap gate routes (spec 9, M8). POST returns pass|advisory + reason codes and
// records a bursar_gate_checks row. ADVISORY ONLY: no enforcement, no bill-api preHandler, no
// blocking verdict, no composition with Burn's precheck. There is no gate.override permission,
// because the gate never blocks.
export default async function gateRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.post('/gate/scope-gap', { preHandler: [requireAuth, can('bursar.gate.check')] }, async (request, reply) => {
    const parsed = bursarScopeGapSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const result = await gate.evaluateScopeGap(viewerOf(request), parsed.data, 'api', viewerOf(request).id);
    return { data: result };
  });

  fastify.get('/gate/checks', { preHandler: [requireAuth, can('bursar.gate.read')] }, async (request) => {
    return gate.listGateChecks(viewerOf(request));
  });
}
