import type { FastifyInstance } from 'fastify';
import { burnRuleCreateSchema, burnRuleUpdateSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import * as rules from '../services/rules.service.js';

/**
 * Rule authoring is OWNER/ADMIN-ONLY (`burn.rule.write`, spec 2.3.3 / 2.4 point 8) and has
 * no MCP tool at all. Both facts have the same cause: a rule is a member-reachable path that
 * can NEUTRALIZE THE GATE without touching gate settings, without an override, and without
 * leaving a precheck label. Reading rules stays at `burn.attribution.read` so a member can
 * see why their work was attributed the way it was.
 */
export default async function ruleRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/rules', { preHandler: [requireAuth, can('burn.attribution.read')] }, async (request) =>
    rules.listRules(readViewer(request)),
  );

  fastify.post(
    '/rules',
    { preHandler: [requireAuth, can('burn.rule.write')] },
    async (request, reply) => {
      const parsed = burnRuleCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await rules.createRule(viewerOf(request), parsed.data);
        reply.status(201);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/rules/:id',
    { preHandler: [requireAuth, can('burn.rule.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnRuleUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return await rules.updateRule(viewerOf(request), id, parsed.data);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/rules/:id',
    { preHandler: [requireAuth, can('burn.rule.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await rules.deleteRule(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
