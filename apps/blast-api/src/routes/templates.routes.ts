import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as templateService from '../services/template.service.js';

const templateTypes = ['campaign', 'drip_step', 'transactional', 'system'] as const;

const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  subject_template: z.string().min(1).max(500),
  html_body: z.string().min(1),
  json_design: z.unknown().optional(),
  plain_text_body: z.string().optional(),
  template_type: z.enum(templateTypes).optional(),
  thumbnail_url: z.string().url().optional(),
});

const updateTemplateSchema = createTemplateSchema.partial();

const listQuerySchema = z.object({
  template_type: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export default async function templateRoutes(fastify: FastifyInstance) {
  // GET /templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await templateService.listTemplates({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /templates
  fastify.post(
    '/templates',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('blast.template.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = createTemplateSchema.parse(request.body);
      const template = await templateService.createTemplate(
        body,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: template });
    },
  );

  // GET /templates/:id
  fastify.get<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const template = await templateService.getTemplate(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: template });
    },
  );

  // PATCH /templates/:id
  fastify.patch<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('blast.template.update'), requireScope('read_write')] },
    async (request, reply) => {
      const body = updateTemplateSchema.parse(request.body);
      const template = await templateService.updateTemplate(
        request.params.id,
        request.user!.org_id,
        body,
        request.user!.id,
      );
      return reply.send({ data: template });
    },
  );

  // DELETE /templates/:id
  fastify.delete<{ Params: { id: string } }>(
    '/templates/:id',
    { preHandler: [requireAuth, fastify.requireCan('blast.template.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await templateService.deleteTemplate(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /templates/:id/preview
  fastify.post<{ Params: { id: string } }>(
    '/templates/:id/preview',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const mergeData = (request.body as Record<string, string> | null) ?? undefined;
      const result = await templateService.previewTemplate(
        request.params.id,
        request.user!.org_id,
        mergeData,
      );
      return reply
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src *")
        .header('X-Content-Type-Options', 'nosniff')
        .send({ data: result });
    },
  );

  // POST /templates/:id/duplicate
  fastify.post<{ Params: { id: string } }>(
    '/templates/:id/duplicate',
    { preHandler: [requireAuth, fastify.requireCan('blast.template.duplicate'), requireScope('read_write')] },
    async (request, reply) => {
      const template = await templateService.duplicateTemplate(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.status(201).send({ data: template });
    },
  );
}
