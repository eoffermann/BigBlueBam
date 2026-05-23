import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { requireAutomationAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as executionService from '../services/execution.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listExecutionsQuerySchema = z.object({
  status: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export default async function executionRoutes(fastify: FastifyInstance) {
  // GET /automations/:id/executions — List executions for an automation
  fastify.get<{ Params: { id: string } }>(
    '/automations/:id/executions',
    { preHandler: [requireAuth, requireAutomationAccess(), shadowOnly('bolt.automation_execution.get')] },
    async (request, reply) => {
      const query = listExecutionsQuerySchema.parse(request.query);
      const result = await executionService.listExecutions({
        automationId: (request as any).automation.id,
        orgId: request.user!.org_id,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // GET /executions — Org-wide execution list (admin only)
  fastify.get(
    '/executions',
    { preHandler: [requireAuth, fastify.requireCan('bolt.execution.list')] },
    async (request, reply) => {
      const query = listExecutionsQuerySchema.parse(request.query);
      const result = await executionService.listOrgExecutions({
        orgId: request.user!.org_id,
        status: query.status,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // GET /executions/:id — Get execution detail with steps
  fastify.get<{ Params: { id: string } }>(
    '/executions/:id',
    { preHandler: [requireAuth, shadowOnly('bolt.execution.get')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!id || !UUID_REGEX.test(id)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid execution id is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const execution = await executionService.getExecution(id, request.user!.org_id);
      if (!execution) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Execution not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: execution });
    },
  );

  // POST /executions/:id/retry — Retry a failed execution
  fastify.post<{ Params: { id: string } }>(
    '/executions/:id/retry',
    { preHandler: [requireAuth, fastify.requireCan('bolt.execution_retry.create')] },
    async (request, reply) => {
      const { id } = request.params;
      if (!id || !UUID_REGEX.test(id)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid execution id is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      const execution = await executionService.retryExecution(id, request.user!.org_id);
      return reply.status(201).send({ data: execution });
    },
  );
}
