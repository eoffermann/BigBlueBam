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
    try {
      const result = await executeQuery(product, entity, config as unknown as QueryConfig, org_id);
      return { data: { rows: result.rows, duration_ms: result.duration_ms } };
    } catch (err) {
      // A bad DEFINITION (unknown column/table/function, bad cast, or a field that
      // does not exist on the entity) is a CLIENT error, not an outage. Postgres
      // signals these with specific SQLSTATEs; surface them as 400 so the caller
      // (Basis) can mark the metric resolve_failed instead of treating a permanent
      // definition problem as a transient 5xx it will retry forever.
      const code = (err as { code?: string } | null)?.code;
      const DEFINITION_ERRORS = new Set([
        '42703', // undefined_column
        '42P01', // undefined_table
        '42883', // undefined_function
        '42P18', // indeterminate_datatype
        '42804', // datatype_mismatch
        '22P02', // invalid_text_representation
        '42601', // syntax_error (bad identifier injected into the built query)
      ]);
      if (code && DEFINITION_ERRORS.has(code)) {
        return reply.status(400).send({
          error: {
            code: 'DEFINITION_RESOLVE_FAILED',
            message: (err as Error).message || 'The query definition did not resolve against its data source',
            details: [{ path: 'config', message: `postgres ${code}` }],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  });
}
