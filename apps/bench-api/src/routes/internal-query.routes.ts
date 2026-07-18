import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { executeQuery, type QueryConfig } from '../services/query.service.js';

/**
 * Internal, secret-gated governed-query route for server-to-server callers
 * (Basis). Bench's org isolation is entirely the `orgId` argument to
 * buildQuery, so this route enforces org via a trusted first-party contract:
 * the caller presents INTERNAL_SERVICE_SECRET plus an explicit `org_id` it has
 * already authenticated (Basis derives it from its own requireAuth). This is
 * the same first-party fan-out pattern the platform workers use.
 *
 * Fails closed: if INTERNAL_SERVICE_SECRET is unset (platform default empty),
 * every call is rejected.
 */
const bodySchema = z.object({
  product: z.string().min(1).max(40),
  entity: z.string().min(1).max(80),
  org_id: z.string().uuid(),
  config: z.record(z.string(), z.unknown()),
});

export default async function internalQueryRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/query', async (request, reply) => {
    const secret = env.INTERNAL_SERVICE_SECRET;
    const presented = request.headers['x-internal-secret'];
    if (!secret || presented !== secret) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or missing internal service secret',
          details: [],
          request_id: request.id,
        },
      });
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid internal query request',
          details: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
          request_id: request.id,
        },
      });
    }

    const { product, entity, org_id, config } = parsed.data;
    const result = await executeQuery(product, entity, config as unknown as QueryConfig, org_id);
    return { data: { rows: result.rows, duration_ms: result.duration_ms } };
  });
}
