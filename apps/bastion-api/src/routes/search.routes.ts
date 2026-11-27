import type { FastifyInstance } from 'fastify';
import { bastionSearchQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { handled, validationError, viewerOf } from '../lib/http.js';
import { policyDeps } from '../services/evidence-runtime.js';
import { searchBastion } from '../services/search.service.js';

// Spec 5.1 row 95 (M10): what the platform's search_everything reads for Bastion (spec 8.5).
// Controls need control.read; linked policies are added only when the caller (and the asker, if
// any, #217) also holds policy.read. Each hit's entity_type is its can_access type, so
// search_everything can gate it for an asker.
export default async function searchRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const asker = (p: string) => fastify.requireAskerCan(p);

  fastify.get('/search', { preHandler: [requireAuth, can('bastion.control.read'), asker('bastion.control.read')] }, async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    const parsed = bastionSearchQuerySchema.safeParse({ q: raw.q, limit: raw.limit || undefined });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const includePolicies = await fastify.bastionCan(request, 'bastion.policy.read');
      return searchBastion(policyDeps(fastify.log, fastify.redis), viewerOf(request), parsed.data, { includePolicies });
    });
  });
}
