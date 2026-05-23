import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as templateService from '../services/template.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  board_id: z.string().uuid().optional(),
});

const instantiateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  project_id: z.string().uuid().optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

const listTemplatesQuerySchema = z.object({
  category: z.string().max(100).optional(),
});

function validateUuid(id: string, request: any, reply: any) {
  if (!id || !UUID_REGEX.test(id)) {
    reply.status(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: 'Valid template id is required',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

export default async function templateRoutes(fastify: FastifyInstance) {
  // GET /templates - List system + org templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth, shadowOnly('board.template.list')] },
    async (request, reply) => {
      const { category } = listTemplatesQuerySchema.parse(request.query);
      const templates = await templateService.listTemplates(
        request.user!.org_id,
        category,
      );
      return reply.send({ data: templates });
    },
  );

  // POST /templates - Create template (optionally from a board)
  fastify.post(
    '/templates',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('board.template.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createTemplateSchema.parse(request.body);
      const template = await templateService.createTemplate(
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: template });
    },
  );

  // PATCH /templates/:id - Update template
  fastify.patch<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('board.template.update'), requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!validateUuid(id, request, reply)) return;
      const data = updateTemplateSchema.parse(request.body);
      const template = await templateService.updateTemplate(id, data, request.user!.org_id);
      return reply.send({ data: template });
    },
  );

  // DELETE /templates/:id - Delete template
  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('board.template.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!validateUuid(id, request, reply)) return;
      await templateService.deleteTemplate(id, request.user!.org_id);
      return reply.status(204).send();
    },
  );

  // POST /templates/:id/instantiate - Create a new board from a template
  fastify.post<{ Params: { id: string } }>(
    '/templates/:id/instantiate',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('board.template_instantiate.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!validateUuid(id, request, reply)) return;
      const body = instantiateSchema.parse(request.body ?? {});
      const board = await templateService.instantiateTemplate(
        id,
        body,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: { id: board.id, name: board.name } });
    },
  );
}
