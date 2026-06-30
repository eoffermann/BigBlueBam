/**
 * Blip field-catalog routes (Blip §7.3, §15). List the observed field catalog for
 * a report type (member), promote a field to indexed (admin), and toggle the
 * Bench-metric flag (admin). The `:f` path segment is the field_path, URL-encoded.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as fieldService from '../services/field.service.js';

const setMetricSchema = z.object({ is_metric: z.boolean() });

export default async function fieldsRoutes(fastify: FastifyInstance) {
  // GET /apps/:id/types/:t/fields — list the field catalog for a report type.
  fastify.get<{ Params: { id: string; t: string } }>(
    '/apps/:id/types/:t/fields',
    { preHandler: [requireAuth, fastify.requireCan('blip.entry.read')] },
    async (request, reply) => {
      try {
        const fields = await fieldService.listFields(
          request.params.id,
          request.user!.active_org_id,
          decodeURIComponent(request.params.t),
        );
        return reply.send({ data: fields });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/types/:t/fields/:f/index — promote a field to indexed.
  fastify.post<{ Params: { id: string; t: string; f: string } }>(
    '/apps/:id/types/:t/fields/:f/index',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.field.index')] },
    async (request, reply) => {
      try {
        const result = await fieldService.indexField(
          request.params.id,
          request.user!.active_org_id,
          decodeURIComponent(request.params.t),
          decodeURIComponent(request.params.f),
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/types/:t/fields/:f/metric — mark / unmark a Bench metric.
  fastify.post<{ Params: { id: string; t: string; f: string } }>(
    '/apps/:id/types/:t/fields/:f/metric',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.field.metric')] },
    async (request, reply) => {
      try {
        const body = setMetricSchema.parse(request.body);
        const row = await fieldService.setMetric(
          request.params.id,
          request.user!.active_org_id,
          decodeURIComponent(request.params.t),
          decodeURIComponent(request.params.f),
          body.is_metric,
        );
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
