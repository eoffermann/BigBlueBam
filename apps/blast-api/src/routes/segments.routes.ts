import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as segmentService from '../services/segment.service.js';

const filterConditionSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.unknown(),
});

const createSegmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  filter_criteria: z.object({
    conditions: z.array(filterConditionSchema).min(1).max(20),
    match: z.enum(['all', 'any']),
  }),
});

const updateSegmentSchema = createSegmentSchema.partial();

const listQuerySchema = z.object({
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export default async function segmentRoutes(fastify: FastifyInstance) {
  // GET /segments
  fastify.get(
    '/segments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await segmentService.listSegments({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /segments
  fastify.post(
    '/segments',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('blast.segment.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createSegmentSchema.parse(request.body);
      const segment = await segmentService.createSegment(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: segment });
    },
  );

  // GET /segments/:id
  fastify.get<{ Params: { id: string } }>(
    '/segments/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const segment = await segmentService.getSegment(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: segment });
    },
  );

  // PATCH /segments/:id
  fastify.patch<{ Params: { id: string } }>(
    '/segments/:id',
    { preHandler: [requireAuth, fastify.requireCan('blast.segment.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateSegmentSchema.parse(request.body);
      const segment = await segmentService.updateSegment(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: segment });
    },
  );

  // DELETE /segments/:id
  fastify.delete<{ Params: { id: string } }>(
    '/segments/:id',
    { preHandler: [requireAuth, fastify.requireCan('blast.segment.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await segmentService.deleteSegment(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /segments/:id/count
  fastify.post<{ Params: { id: string } }>(
    '/segments/:id/count',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await segmentService.recalculateSegmentCount(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // GET /segments/:id/preview
  fastify.get<{ Params: { id: string } }>(
    '/segments/:id/preview',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await segmentService.previewSegmentContacts(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /segments/:id/evaluate -- Full recipient evaluation for campaign send
  fastify.post<{ Params: { id: string } }>(
    '/segments/:id/evaluate',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await segmentService.evaluateSegmentRecipients(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );
}
