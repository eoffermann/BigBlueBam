import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createBasisMetricSchema,
  updateBasisMetricSchema,
  createBasisVersionSchema,
  basisExplainRequestSchema,
  updateBasisOrgSettingsSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import * as metricService from '../services/metric.service.js';
import * as explainService from '../services/explain.service.js';
import * as settingsService from '../services/settings.service.js';
import { UpstreamUnavailableError, BadDefinitionError } from '../lib/bench-client.js';

function notFound(request: FastifyRequest, reply: FastifyReply, what = 'Metric not found') {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: what, details: [], request_id: request.id },
  });
}

function validationError(request: FastifyRequest, reply: FastifyReply, err: import('zod').ZodError) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
      request_id: request.id,
    },
  });
}

function upstreamUnavailable(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(503).send({
    error: {
      code: 'UPSTREAM_UNAVAILABLE',
      message:
        'The Bench query service is unavailable, so live metric values cannot be computed right now.',
      details: [],
      request_id: request.id,
    },
  });
}

// Map a Bench upstream error to the right response: a bad definition (4xx) is a
// 400 the caller must fix; a real outage (5xx/network) is a 503 degrade.
function benchError(request: FastifyRequest, reply: FastifyReply, err: unknown): boolean {
  if (err instanceof BadDefinitionError) {
    reply.status(400).send({
      error: {
        code: 'DEFINITION_RESOLVE_FAILED',
        message: `This metric's definition did not resolve against its data source: ${err.message}`,
        details: [],
        request_id: request.id,
      },
    });
    return true;
  }
  if (err instanceof UpstreamUnavailableError) {
    upstreamUnavailable(request, reply);
    return true;
  }
  return false;
}

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

  // POST /v1/metrics/:id/versions - new immutable version (definition change)
  fastify.post(
    '/metrics/:id/versions',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.version')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = createBasisVersionSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const version = await metricService.addVersion(
        request.user!.org_id,
        request.user!.id,
        id,
        parsed.data,
      );
      if (!version) return notFound(request, reply);
      return reply.status(201).send({ data: version });
    },
  );

  // GET /v1/metrics/:id/versions - version history
  fastify.get(
    '/metrics/:id/versions',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request) => {
      const { id } = request.params as { id: string };
      const rows = await metricService.listVersions(request.user!.org_id, id);
      return { data: rows };
    },
  );

  // Certification transitions
  const transition = (
    verb: 'certify' | 'decertify' | 'deprecate',
    perm: string,
    fn: (orgId: string, userId: string, id: string) => Promise<unknown>,
    method: 'post' | 'delete',
  ) => {
    const path = verb === 'deprecate' ? '/metrics/:id' : `/metrics/:id/${verb}`;
    fastify[method](
      path,
      { preHandler: [requireAuth, fastify.requireCan(perm)] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const updated = await fn(request.user!.org_id, request.user!.id, id);
        if (!updated) return notFound(request, reply);
        return { data: updated };
      },
    );
  };
  transition('certify', 'basis.metric.certify', metricService.certifyMetric, 'post');
  transition('decertify', 'basis.metric.decertify', metricService.decertifyMetric, 'post');
  transition('deprecate', 'basis.metric.deprecate', metricService.deprecateMetric, 'delete');

  // GET /v1/metrics/:id/resolve - binding contract: query config + presentation
  // envelope (Bench prefers these over local kpi_config when a widget binds).
  fastify.get(
    '/metrics/:id/resolve',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await metricService.getMetric(request.user!.org_id, id);
      if (!result) return notFound(request, reply);
      return {
        data: {
          metric_id: result.metric.id,
          slug: result.metric.slug,
          definition: result.currentVersion?.definition ?? null,
          presentation: {
            display_name: result.metric.name,
            unit: result.metric.unit,
            favorable_direction: result.metric.favorable_direction,
            target: result.metric.target,
          },
          certification: result.metric.certification,
        },
      };
    },
  );

  // GET /v1/metrics/:id/value?from&to - scalar value for a period
  fastify.get(
    '/metrics/:id/value',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const q = request.query as { from?: string; to?: string };
      if (!q.from || !q.to) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'from and to query params are required (ISO timestamps)',
            details: [],
            request_id: request.id,
          },
        });
      }
      try {
        const result = await explainService.getValue(request.user!.org_id, id, {
          from: q.from,
          to: q.to,
        });
        if (!result) return notFound(request, reply);
        return { data: result };
      } catch (err) {
        if (benchError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // POST /v1/metrics/:id/explain - deterministic decomposition (+ per-viewer aid)
  fastify.post(
    '/metrics/:id/explain',
    { preHandler: [requireAuth, fastify.requireCan('basis.explain.run')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = basisExplainRequestSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await explainService.explain(request.user!.org_id, id, parsed.data);
        if ('notFound' in result) return notFound(request, reply);
        if ('noDimension' in result) {
          return reply.status(400).send({
            error: {
              code: 'DIMENSION_NOT_ALLOWED',
              message:
                'No decomposition dimension could be resolved (pass one, set metric default_dimensions, or an org default).',
              details: [],
              request_id: request.id,
            },
          });
        }
        return { data: result.explanation };
      } catch (err) {
        if (benchError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // GET /v1/settings - per-org Basis settings
  fastify.get(
    '/settings',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.read')] },
    async (request) => {
      const settings = await settingsService.getSettings(request.user!.org_id);
      return { data: settings };
    },
  );

  // PUT /v1/settings - update per-org Basis settings
  fastify.put(
    '/settings',
    { preHandler: [requireAuth, fastify.requireCan('basis.metric.update')] },
    async (request, reply) => {
      const parsed = updateBasisOrgSettingsSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const settings = await settingsService.upsertSettings(
        request.user!.org_id,
        request.user!.id,
        parsed.data,
      );
      return { data: settings };
    },
  );
}
