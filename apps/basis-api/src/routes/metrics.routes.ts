import type { FastifyInstance } from 'fastify';
import { createBasisMetricSchema, updateBasisMetricSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import * as metricService from '../services/metric.service.js';

// Metric catalog CRUD (spec 4.2). Definition changes go through /versions
// (a later slice); this covers list, create-draft, get, and metadata update.
export default async function metricRoutes(fastify: FastifyInstance) {
  // GET /v1/metrics
  fastify.get(
    '/metrics',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request) => {
      const q = request.query as { filter?: Record<string, string>; limit?: string };
      const certification = q.filter?.certification;
      const limit = Math.min(Number(q.limit) || 100, 200);
      const rows = await metricService.listMetrics(request.user!.org_id, {
        certification,
        limit,
      });
      return { data: rows };
    },
  );

  // POST /v1/metrics - create a draft + first version
  fastify.post(
    '/metrics',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.define')] },
    async (request, reply) => {
      const parsed = createBasisMetricSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid metric definition',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const orgId = request.user!.org_id;
      if (await metricService.slugExists(orgId, parsed.data.slug)) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: `A metric with slug '${parsed.data.slug}' already exists in this organization`,
            details: [],
            request_id: request.id,
          },
        });
      }
      const result = await metricService.createMetric(orgId, request.user!.id, parsed.data);
      return reply.status(201).send({ data: result });
    },
  );

  // GET /v1/metrics/:id
  fastify.get(
    '/metrics/:id',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await metricService.getMetric(request.user!.org_id, id);
      if (!result) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Metric not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return { data: result };
    },
  );

  // PATCH /v1/metrics/:id - metadata only (not the definition)
  fastify.patch(
    '/metrics/:id',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.update')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateBasisMetricSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid metric metadata',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const updated = await metricService.updateMetricMetadata(
        request.user!.org_id,
        id,
        parsed.data,
      );
      if (!updated) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Metric not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return { data: updated };
    },
  );
}
