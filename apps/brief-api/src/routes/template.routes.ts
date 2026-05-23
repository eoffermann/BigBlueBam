import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as templateService from '../services/template.service.js';

const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  html_preview: z.string().max(5_000_000).nullable().optional(),
  sort_order: z.number().int().optional(),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  html_preview: z.string().max(5_000_000).nullable().optional(),
  sort_order: z.number().int().optional(),
});

export default async function templateRoutes(fastify: FastifyInstance) {
  // GET /templates — List system + org templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth, shadowOnly('brief.template.list')] },
    async (request, reply) => {
      const templates = await templateService.listTemplates(request.user!.org_id);
      return reply.send({ data: templates });
    },
  );

  // POST /templates — Create an org template
  fastify.post(
    '/templates',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('brief.template.create'), requireScope('read_write')],
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

  // PATCH /templates/:id — Update a template
  fastify.patch<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('brief.template.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateTemplateSchema.parse(request.body);
      const template = await templateService.updateTemplate(
        request.params.id,
        data,
        request.user!.org_id,
      );
      return reply.send({ data: template });
    },
  );

  // DELETE /templates/:id — Delete a template
  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('brief.template.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const deleted = await templateService.deleteTemplate(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: deleted });
    },
  );
}
