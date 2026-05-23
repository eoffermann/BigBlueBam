import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as templateService from '../services/template.service.js';
import * as automationService from '../services/automation.service.js';

const instantiateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  cron_expression: z.string().max(100).nullable().optional(),
  cron_timezone: z.string().max(50).optional(),
});

export default async function templateRoutes(fastify: FastifyInstance) {
  // GET /templates — List pre-built automation templates
  fastify.get(
    '/templates',
    { preHandler: [requireAuth, shadowOnly('bolt.template.list')] },
    async (_request, reply) => {
      const templates = templateService.listTemplates();
      return reply.send({ data: templates });
    },
  );

  // POST /templates/:id/instantiate — Create automation from template
  fastify.post<{ Params: { id: string } }>(
    '/templates/:id/instantiate',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bolt.template_instantiate.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const { id } = request.params;
      const template = templateService.getTemplate(id);
      if (!template) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Template not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const overrides = instantiateSchema.parse(request.body ?? {});
      const definition = templateService.instantiateTemplate(template, overrides);

      const automation = await automationService.createAutomation(
        {
          name: definition.name,
          description: definition.description,
          project_id: definition.project_id,
          trigger_source: definition.trigger_source as automationService.TriggerSource,
          trigger_event: definition.trigger_event,
          cron_expression: definition.cron_expression,
          cron_timezone: definition.cron_timezone,
          conditions: definition.conditions.map((c) => ({
            sort_order: c.sort_order,
            field: c.field,
            operator: c.operator as automationService.ConditionOperator,
            value: c.value,
            logic_group: (c.logic_group ?? 'and') as automationService.LogicGroup,
          })),
          actions: definition.actions.map((a) => ({
            sort_order: a.sort_order,
            mcp_tool: a.mcp_tool,
            parameters: a.parameters,
            on_error: (a.on_error ?? 'stop') as automationService.OnError,
          })),
        },
        request.user!.id,
        request.user!.org_id,
      );

      return reply.status(201).send({ data: automation });
    },
  );
}
