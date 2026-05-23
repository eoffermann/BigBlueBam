import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import * as llmService from '../services/llm-provider.service.js';
import { validateExternalUrl } from '../lib/url-validator.js';

const createSchema = z.object({
  scope: z.enum(['system', 'organization', 'project']),
  organization_id: z.string().uuid().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(),
  name: z.string().min(1).max(100),
  provider_type: z.enum(['anthropic', 'openai', 'openai_compatible']),
  model_id: z.string().min(1).max(200),
  api_endpoint: z.string().url().max(2048).optional().nullable(),
  api_key: z.string().min(1).max(500),
  max_tokens: z.number().int().min(1).max(1000000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  is_default: z.boolean().optional(),
  enabled: z.boolean().optional(),
  max_requests_per_hour: z.number().int().min(1).max(100000).optional(),
  max_tokens_per_hour: z.number().int().min(1).max(100000000).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  provider_type: z.enum(['anthropic', 'openai', 'openai_compatible']).optional(),
  model_id: z.string().min(1).max(200).optional(),
  api_endpoint: z.string().url().max(2048).optional().nullable(),
  api_key: z.string().min(1).max(500).optional(),
  max_tokens: z.number().int().min(1).max(1000000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  is_default: z.boolean().optional(),
  enabled: z.boolean().optional(),
  max_requests_per_hour: z.number().int().min(1).max(100000).optional(),
  max_tokens_per_hour: z.number().int().min(1).max(100000000).optional(),
});

export default async function llmProviderRoutes(fastify: FastifyInstance) {
  // -----------------------------------------------------------------------
  // GET /llm-providers — List providers visible to the user
  // -----------------------------------------------------------------------
  fastify.get(
    '/llm-providers',
    { preHandler: [requireAuth, fastify.requireCan('bam.llm_provider.list')] },
    async (request, reply) => {
      const { project_id } = request.query as { project_id?: string };
      const data = await llmService.listProviders(
        request.user!.org_id,
        project_id,
        request.user!.is_superuser,
      );
      return reply.send({ data });
    },
  );

  // -----------------------------------------------------------------------
  // POST /llm-providers — Create a provider
  // -----------------------------------------------------------------------
  fastify.post(
    '/llm-providers',
    {
      preHandler: [requireAuth, fastify.requireCan('bam.llm_provider.create')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = createSchema.parse(request.body);

      // Scope-based authorization
      if (body.scope === 'system' && !request.user!.is_superuser) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only SuperUsers can create system-level LLM providers',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (body.scope === 'organization') {
        if (!request.user!.is_superuser && !['admin', 'owner'].includes(request.user!.role)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Only organization admins can create org-level LLM providers',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      if (body.scope === 'project') {
        if (!body.project_id) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'project_id is required for project-scope providers',
              details: [{ field: 'project_id', issue: 'required' }],
              request_id: request.id,
            },
          });
        }
        if (!request.user!.is_superuser && !['admin', 'owner'].includes(request.user!.role)) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Only project admins can create project-level LLM providers',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // SSRF protection: validate api_endpoint if provided (BAM-021)
      if (body.api_endpoint) {
        const urlCheck = validateExternalUrl(body.api_endpoint);
        if (!urlCheck.safe) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid api_endpoint: ${urlCheck.reason}`,
              details: [{ field: 'api_endpoint', issue: urlCheck.reason }],
              request_id: request.id,
            },
          });
        }
      }

      // openai_compatible requires an endpoint
      if (body.provider_type === 'openai_compatible' && !body.api_endpoint) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'api_endpoint is required for openai_compatible providers',
            details: [{ field: 'api_endpoint', issue: 'required for openai_compatible' }],
            request_id: request.id,
          },
        });
      }

      // Set org_id from the authenticated user's context for non-system scopes
      const createData = {
        ...body,
        organization_id: body.scope === 'system' ? null : (body.organization_id ?? request.user!.org_id),
        temperature: body.temperature !== undefined ? String(body.temperature) : undefined,
      };

      const provider = await llmService.createProvider(createData, request.user!.id);
      return reply.status(201).send({ data: provider });
    },
  );

  // -----------------------------------------------------------------------
  // GET /llm-providers/resolve — Resolve effective provider for context
  // -----------------------------------------------------------------------
  fastify.get(
    '/llm-providers/resolve',
    { preHandler: [requireAuth, fastify.requireCan('bam.llm_provider_resolve.list')] },
    async (request, reply) => {
      const { project_id } = request.query as { project_id?: string };
      const provider = await llmService.resolveProvider(
        request.user!.org_id,
        project_id,
      );

      if (!provider) {
        return reply.send({
          data: null,
          message: 'No LLM provider configured. Ask your organization administrator to set up an AI provider in Settings.',
        });
      }

      return reply.send({ data: provider });
    },
  );

  // -----------------------------------------------------------------------
  // GET /llm-providers/:id — Get provider detail
  // -----------------------------------------------------------------------
  fastify.get<{ Params: { id: string } }>(
    '/llm-providers/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.llm_provider.get')] },
    async (request, reply) => {
      const provider = await llmService.getProvider(
        request.params.id,
        request.user!.org_id,
        request.user!.is_superuser,
      );

      if (!provider) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'LLM provider not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: provider });
    },
  );

  // -----------------------------------------------------------------------
  // PATCH /llm-providers/:id — Update provider
  // -----------------------------------------------------------------------
  fastify.patch<{ Params: { id: string } }>(
    '/llm-providers/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.llm_provider.update'),
      ],
    },
    async (request, reply) => {
      const body = updateSchema.parse(request.body);

      // SSRF protection: validate api_endpoint if provided (BAM-021)
      if (body.api_endpoint) {
        const urlCheck = validateExternalUrl(body.api_endpoint);
        if (!urlCheck.safe) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid api_endpoint: ${urlCheck.reason}`,
              details: [{ field: 'api_endpoint', issue: urlCheck.reason }],
              request_id: request.id,
            },
          });
        }
      }

      const updated = await llmService.updateProvider(
        request.params.id,
        {
          ...body,
          temperature: body.temperature !== undefined ? String(body.temperature) : undefined,
        },
        request.user!.id,
        request.user!.org_id,
        request.user!.is_superuser,
      );

      if (!updated) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'LLM provider not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: updated });
    },
  );

  // -----------------------------------------------------------------------
  // DELETE /llm-providers/:id — Delete provider
  // -----------------------------------------------------------------------
  fastify.delete<{ Params: { id: string } }>(
    '/llm-providers/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.llm_provider.delete')] },
    async (request, reply) => {
      const deleted = await llmService.deleteProvider(
        request.params.id,
        request.user!.org_id,
        request.user!.is_superuser,
      );

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'LLM provider not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  // -----------------------------------------------------------------------
  // POST /llm-providers/:id/test — Test provider connectivity
  // -----------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/llm-providers/:id/test',
    {
      preHandler: [requireAuth, fastify.requireCan('bam.llm_provider_test.create')],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const result = await llmService.testProvider(
        request.params.id,
        request.user!.org_id,
        request.user!.is_superuser,
      );

      if (!result.success && result.message === 'Provider not found') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'LLM provider not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!result.success && result.message === 'Forbidden') {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to test this provider',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: result });
    },
  );
}
