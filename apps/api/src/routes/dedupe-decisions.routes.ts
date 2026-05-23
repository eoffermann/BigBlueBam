import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  DEDUPE_DECISION_VALUES,
  listPending,
  recordDecision,
} from '../services/dedupe-decisions.service.js';

/**
 * Dedupe-decision REST routes (Wave 5 AGENTIC_TODO §7).
 *
 *   POST /v1/dedupe-decisions           — record a decision (canonicalized)
 *   GET  /v1/dedupe-decisions/pending   — list pending / due-for-resurface rows
 *
 * The MCP tools dedupe_record_decision and dedupe_list_pending wrap
 * these endpoints. Service callers may also hit them directly for
 * operator tooling. Agents who try to overwrite a human-recorded
 * decision receive 409 HUMAN_DECISION_EXISTS with the prior row.
 */

const recordSchema = z.object({
  entity_type: z.string().min(1).max(64),
  id_a: z.string().uuid(),
  id_b: z.string().uuid(),
  decision: z.enum(DEDUPE_DECISION_VALUES),
  reason: z.string().max(4000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  resurface_after: z
    .string()
    .datetime({ offset: true })
    .optional(),
});

const listPendingQuerySchema = z.object({
  entity_type: z.string().min(1).max(64).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export default async function dedupeDecisionsRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // POST /v1/dedupe-decisions
  // ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/v1/dedupe-decisions',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.dedupe_decision.create')],
    },
    async (request, reply) => {
      const parsed = recordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid dedupe decision body',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const { entity_type, id_a, id_b, decision, reason, confidence, resurface_after } = parsed.data;
      const result = await recordDecision({
        org_id: request.user!.active_org_id,
        actor_user_id: request.user!.id,
        entity_type,
        id_a,
        id_b,
        decision,
        reason,
        confidence,
        resurface_after: resurface_after ? new Date(resurface_after) : null,
      });

      if (!result.ok) {
        return reply.status(result.status).send({
          error: {
            code: result.code,
            message: result.message,
            details: [],
            request_id: request.id,
          },
          ...(result.prior_decision ? { prior_decision: result.prior_decision } : {}),
        });
      }

      return reply.status(result.created ? 201 : 200).send({ data: result.data, created: result.created });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/dedupe-decisions/pending
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/v1/dedupe-decisions/pending',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.dedupe_decision_pending.list')],
    },
    async (request, reply) => {
      const parsed = listPendingQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid dedupe pending query',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const result = await listPending({
        org_id: request.user!.active_org_id,
        entity_type: parsed.data.entity_type,
        since: parsed.data.since ? new Date(parsed.data.since) : undefined,
        limit: parsed.data.limit,
      });
      return reply.send({ pending: result.data });
    },
  );
}
