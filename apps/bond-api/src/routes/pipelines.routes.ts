import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as pipelineService from '../services/pipeline.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createStageSchema = z.object({
  name: z.string().min(1).max(100),
  sort_order: z.number().int().optional(),
  stage_type: z.enum(['active', 'won', 'lost']).optional(),
  probability_pct: z.number().int().min(0).max(100).optional(),
  rotting_days: z.number().int().positive().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateStageSchema = createStageSchema.partial();

const createPipelineSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().optional(),
  currency: z.string().length(3).optional(),
  stages: z.array(createStageSchema).optional(),
});

const updatePipelineSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  is_default: z.boolean().optional(),
  currency: z.string().length(3).optional(),
});

const reorderStagesSchema = z.object({
  stage_ids: z.array(z.string().uuid()).min(1),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function pipelineRoutes(fastify: FastifyInstance) {
  // GET /pipelines — List pipelines
  fastify.get(
    '/pipelines',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const pipelines = await pipelineService.listPipelines(request.user!.org_id);
      return reply.send({ data: pipelines });
    },
  );

  // POST /pipelines — Create pipeline
  fastify.post(
    '/pipelines',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bond.pipeline.create'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = createPipelineSchema.parse(request.body);
      const pipeline = await pipelineService.createPipeline(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: pipeline });
    },
  );

  // GET /pipelines/:id — Get pipeline detail
  fastify.get<{ Params: { id: string } }>(
    '/pipelines/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const pipeline = await pipelineService.getPipeline(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: pipeline });
    },
  );

  // PATCH /pipelines/:id — Update pipeline
  fastify.patch<{ Params: { id: string } }>(
    '/pipelines/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline.update'), requireScope('admin')] },
    async (request, reply) => {
      const body = updatePipelineSchema.parse(request.body);
      const pipeline = await pipelineService.updatePipeline(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: pipeline });
    },
  );

  // DELETE /pipelines/:id — Delete pipeline
  fastify.delete<{ Params: { id: string } }>(
    '/pipelines/:id',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline.delete'), requireScope('admin')] },
    async (request, reply) => {
      await pipelineService.deletePipeline(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // GET /pipelines/:id/stages — List stages
  fastify.get<{ Params: { id: string } }>(
    '/pipelines/:id/stages',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const stages = await pipelineService.listStages(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: stages });
    },
  );

  // POST /pipelines/:id/stages — Create stage
  fastify.post<{ Params: { id: string } }>(
    '/pipelines/:id/stages',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline_stage.create'), requireScope('admin')] },
    async (request, reply) => {
      const body = createStageSchema.parse(request.body);
      const stage = await pipelineService.createStage(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.status(201).send({ data: stage });
    },
  );

  // PATCH /pipelines/:id/stages/:stageId — Update stage
  fastify.patch<{ Params: { id: string; stageId: string } }>(
    '/pipelines/:id/stages/:stageId',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline_stage.update'), requireScope('admin')] },
    async (request, reply) => {
      const body = updateStageSchema.parse(request.body);
      const stage = await pipelineService.updateStage(
        request.params.id,
        request.params.stageId,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: stage });
    },
  );

  // DELETE /pipelines/:id/stages/:stageId — Delete stage
  fastify.delete<{ Params: { id: string; stageId: string } }>(
    '/pipelines/:id/stages/:stageId',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline_stage.delete'), requireScope('admin')] },
    async (request, reply) => {
      await pipelineService.deleteStage(
        request.params.id,
        request.params.stageId,
        request.user!.org_id,
      );
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /pipelines/:id/stages/reorder — Reorder stages
  fastify.post<{ Params: { id: string } }>(
    '/pipelines/:id/stages/reorder',
    { preHandler: [requireAuth, fastify.requireCan('bond.pipeline_stage_reorder.create'), requireScope('admin')] },
    async (request, reply) => {
      const body = reorderStagesSchema.parse(request.body);
      const stages = await pipelineService.reorderStages(
        request.params.id,
        request.user!.org_id,
        body.stage_ids,
      );
      return reply.send({ data: stages });
    },
  );
}
