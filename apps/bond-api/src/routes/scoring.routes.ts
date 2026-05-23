import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as scoringService from '../services/scoring.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const conditionOperators = [
  'equals', 'not_equals', 'contains', 'gt', 'lt', 'gte', 'lte', 'exists', 'not_exists',
] as const;

const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  condition_field: z.string().min(1).max(100),
  condition_operator: z.enum(conditionOperators),
  condition_value: z.string().max(500),
  score_delta: z.number().int().min(-100).max(100),
  enabled: z.boolean().optional(),
});

const updateRuleSchema = createRuleSchema.partial();

const scoreContactSchema = z.object({
  contact_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function scoringRoutes(fastify: FastifyInstance) {
  // GET /scoring-rules — List scoring rules
  fastify.get(
    '/scoring-rules',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const rules = await scoringService.listScoringRules(request.user!.org_id);
      return reply.send({ data: rules });
    },
  );

  // POST /scoring-rules — Create scoring rule
  fastify.post(
    '/scoring-rules',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.scoring_rule.create'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = createRuleSchema.parse(request.body);
      const rule = await scoringService.createScoringRule(body, request.user!.org_id);
      return reply.status(201).send({ data: rule });
    },
  );

  // PATCH /scoring-rules/:id — Update scoring rule
  fastify.patch<{ Params: { id: string } }>(
    '/scoring-rules/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.scoring_rule.update'), requireScope('admin')] },
    async (request, reply) => {
      const body = updateRuleSchema.parse(request.body);
      const rule = await scoringService.updateScoringRule(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: rule });
    },
  );

  // DELETE /scoring-rules/:id — Delete scoring rule
  fastify.delete<{ Params: { id: string } }>(
    '/scoring-rules/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.scoring_rule.delete'), requireScope('admin')] },
    async (request, reply) => {
      await scoringService.deleteScoringRule(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /scoring/recalculate — Score a specific contact
  fastify.post(
    '/scoring/recalculate',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.scoring_recalculate.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = scoreContactSchema.parse(request.body);
      const result = await scoringService.scoreContact(body.contact_id, request.user!.org_id);
      return reply.send({ data: result });
    },
  );
}
