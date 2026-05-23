import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  requireAutomationAccess,
  requireAutomationEditAccess,
} from '../middleware/authorize.js';
import * as automationService from '../services/automation.service.js';
import { validateActionTools, validateActionParameters } from '../services/automation.service.js';
import { compileGraphToRows, BoltGraphShapeError } from '../services/bolt-graph-compiler.js';

const TRIGGER_SOURCES = [
  'bam',
  'banter',
  'beacon',
  'brief',
  'helpdesk',
  'schedule',
  'bond',
  'blast',
  'board',
  'bench',
  'bearing',
  'bill',
  'book',
  'blank',
] as const;
const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains',
  'starts_with', 'ends_with', 'greater_than', 'less_than',
  'is_empty', 'is_not_empty', 'in', 'not_in', 'matches_regex',
] as const;
const LOGIC_GROUPS = ['and', 'or'] as const;
const ON_ERROR_MODES = ['stop', 'continue', 'retry'] as const;

// ---------------------------------------------------------------------------
// BoltGraph Zod schema (minimal structural validation; deep node-data
// validation is deferred to the compiler's shape checker)
// ---------------------------------------------------------------------------

const boltGraphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['trigger', 'condition', 'action']),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.unknown()),
});

const boltGraphEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  targetHandle: z.string().min(1),
});

const boltGraphSchema = z.object({
  version: z.literal(1),
  nodes: z.array(boltGraphNodeSchema),
  edges: z.array(boltGraphEdgeSchema),
});

// ---------------------------------------------------------------------------

const conditionSchema = z.object({
  sort_order: z.number().int().min(0).max(100),
  field: z.string().min(1).max(255),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.unknown().optional(),
  logic_group: z.enum(LOGIC_GROUPS).optional().default('and'),
});

const MAX_PARAM_DEPTH = 3;
const MAX_PARAM_SIZE_BYTES = 50 * 1024; // 50 KB

/** Compute maximum nesting depth of an object/array value. */
function jsonDepth(value: unknown, current = 0): number {
  if (current > MAX_PARAM_DEPTH) return current; // short-circuit
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    let max = current + 1;
    for (const child of entries) {
      max = Math.max(max, jsonDepth(child, current + 1));
      if (max > MAX_PARAM_DEPTH) return max; // short-circuit
    }
    return max;
  }
  return current;
}

const actionSchema = z.object({
  sort_order: z.number().int().min(0).max(100),
  mcp_tool: z.string().min(1).max(100),
  parameters: z
    .record(z.unknown())
    .optional()
    .refine(
      (params) => {
        if (!params) return true;
        return jsonDepth(params) <= MAX_PARAM_DEPTH;
      },
      { message: `Action parameters must not exceed ${MAX_PARAM_DEPTH} levels of nesting` },
    )
    .refine(
      (params) => {
        if (!params) return true;
        const size = new TextEncoder().encode(JSON.stringify(params)).length;
        return size <= MAX_PARAM_SIZE_BYTES;
      },
      { message: `Serialized action parameters must not exceed ${MAX_PARAM_SIZE_BYTES / 1024}KB` },
    ),
  on_error: z.enum(ON_ERROR_MODES).optional().default('stop'),
  retry_count: z.number().int().min(0).max(10).optional().default(0),
  retry_delay_ms: z.number().int().min(100).max(300000).optional().default(1000),
});

const createAutomationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional().default(true),
  trigger_source: z.enum(TRIGGER_SOURCES),
  trigger_event: z.string().min(1).max(60),
  trigger_filter: z.record(z.unknown()).nullable().optional(),
  cron_expression: z.string().max(100).nullable().optional(),
  cron_timezone: z.string().max(50).optional().default('UTC'),
  max_executions_per_hour: z.number().int().min(1).max(10000).optional().default(100),
  cooldown_seconds: z.number().int().min(0).max(86400).optional().default(0),
  conditions: z.array(conditionSchema).max(50).optional().default([]),
  actions: z.array(actionSchema).min(1).max(50).optional(),
  /** Optional node-graph. When present, trigger/conditions/actions are derived
   *  from the graph via compileGraphToRows; the graph blob is persisted too. */
  graph: boltGraphSchema.optional(),
}).superRefine((data, ctx) => {
  // Must supply either graph or at least one action
  if (!data.graph && (!data.actions || data.actions.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must provide either "graph" or at least one "actions" entry.',
      path: ['actions'],
    });
  }
});

const updateAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  trigger_source: z.enum(TRIGGER_SOURCES).optional(),
  trigger_event: z.string().min(1).max(60).optional(),
  trigger_filter: z.record(z.unknown()).nullable().optional(),
  cron_expression: z.string().max(100).nullable().optional(),
  cron_timezone: z.string().max(50).optional(),
  max_executions_per_hour: z.number().int().min(1).max(10000).optional(),
  cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  conditions: z.array(conditionSchema).max(50).optional(),
  actions: z.array(actionSchema).min(1).max(50).optional(),
  /** Optional node-graph. When present, trigger/conditions/actions are recompiled
   *  from the graph. When absent, graph column is cleared (null). */
  graph: boltGraphSchema.optional(),
});

const patchAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  enabled: z.boolean().optional(),
});

const listAutomationsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  trigger_source: z.string().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const testAutomationSchema = z.object({
  event: z.record(z.unknown()),
});

export default async function automationRoutes(fastify: FastifyInstance) {
  // GET /automations — List automations
  fastify.get(
    '/automations',
    { preHandler: [requireAuth, shadowOnly('bolt.automation.list')] },
    async (request, reply) => {
      const query = listAutomationsQuerySchema.parse(request.query);
      const result = await automationService.listAutomations({
        orgId: request.user!.org_id,
        projectId: query.project_id,
        triggerSource: query.trigger_source,
        enabled: query.enabled !== undefined ? query.enabled === 'true' : undefined,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // POST /automations — Create automation
  fastify.post(
    '/automations',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bolt.automation.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createAutomationSchema.parse(request.body);

      // Resolve trigger/conditions/actions from graph (if provided)
      let graphBlob: unknown = null;
      let graphMode: string | null = null;
      let resolvedData = data as automationService.CreateAutomationInput;

      if (data.graph) {
        try {
          const compiled = compileGraphToRows(data.graph);
          graphBlob = data.graph;
          graphMode = 'advanced';
          resolvedData = {
            ...data,
            trigger_source: compiled.trigger.source as automationService.TriggerSource,
            trigger_event: compiled.trigger.event,
            trigger_filter: compiled.trigger.filter,
            conditions: compiled.conditions.map((c) => ({
              sort_order: c.sort_order,
              field: c.field,
              operator: c.operator as automationService.ConditionOperator,
              value: c.value,
              logic_group: (c.logic_group ?? 'and') as automationService.LogicGroup,
            })),
            actions: compiled.actions.map((a) => ({
              sort_order: a.sort_order,
              mcp_tool: a.mcp_tool,
              parameters: a.parameters as Record<string, unknown> | undefined,
              on_error: (a.on_error ?? 'stop') as automationService.OnError,
              retry_count: a.retry_count ?? 0,
              retry_delay_ms: a.retry_delay_ms ?? 1000,
            })),
          };
        } catch (err) {
          if (err instanceof BoltGraphShapeError) {
            return reply.status(400).send({
              error: { code: 'GRAPH_SHAPE_ERROR', message: err.message },
            });
          }
          throw err;
        }
      }

      // Validate MCP tool names against allowlist
      validateActionTools(resolvedData.actions as automationService.ActionInput[]);

      // Validate entity references in action parameters belong to the user's org
      await validateActionParameters(
        resolvedData.actions as automationService.ActionInput[],
        request.user!.org_id,
        'strict',
      );

      const automation = await automationService.createAutomation(
        resolvedData,
        request.user!.id,
        request.user!.org_id,
        graphBlob,
        graphMode,
      );
      return reply.status(201).send({ data: automation });
    },
  );

  // GET /automations/stats — Automation statistics
  // Accepts an optional project_id query param so the stats card on the home
  // page stays consistent with the list query underneath it. Without this,
  // a user with an active project filter would see "13 total" but an empty
  // list (the list filtered by project, the stats didn't).
  fastify.get(
    '/automations/stats',
    { preHandler: [requireAuth, shadowOnly('bolt.automation_stat.list')] },
    async (request, reply) => {
      const query = z
        .object({ project_id: z.string().uuid().optional() })
        .parse(request.query);
      const stats = await automationService.getStats(
        request.user!.org_id,
        query.project_id,
      );
      return reply.send({ data: stats });
    },
  );

  // GET /automations/by-name/:name — Resolve an automation by its name.
  // Case-insensitive exact match preferred; single-hit fuzzy fallback.
  // Returns a resolver-friendly projection (no conditions/actions) with
  // aggregate action_count and last_execution_at. Returns { data: null }
  // on miss rather than 404 so the MCP resolver tool can return null
  // directly without special-casing error envelopes.
  fastify.get<{ Params: { name: string } }>(
    '/automations/by-name/:name',
    { preHandler: [requireAuth, shadowOnly('bolt.automation_by_name.get')] },
    async (request, reply) => {
      const rawName = request.params.name;
      if (!rawName || rawName.trim().length === 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'name parameter is required',
            details: [{ field: 'name', issue: 'required' }],
            request_id: request.id,
          },
        });
      }

      const result = await automationService.getAutomationByName(
        rawName,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // GET /automations/:id — Get automation with conditions and actions
  fastify.get<{ Params: { id: string } }>(
    '/automations/:id',
    { preHandler: [requireAuth, requireAutomationAccess(), shadowOnly('bolt.automation.get')] },
    async (request, reply) => {
      const full = await automationService.getAutomation(
        (request as any).automation.id,
        request.user!.org_id,
      );
      return reply.send({ data: full });
    },
  );

  // PUT /automations/:id — Full update
  fastify.put<{ Params: { id: string } }>(
    '/automations/:id',
    { preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateAutomationSchema.parse(request.body);

      // Resolve trigger/conditions/actions from graph (if provided)
      let graphBlob: unknown | null = null;
      let graphMode: string | null = null;
      let resolvedData = data as automationService.UpdateAutomationInput;

      if (data.graph) {
        try {
          const compiled = compileGraphToRows(data.graph);
          graphBlob = data.graph;
          graphMode = 'advanced';
          resolvedData = {
            ...data,
            trigger_source: compiled.trigger.source as automationService.TriggerSource,
            trigger_event: compiled.trigger.event,
            trigger_filter: compiled.trigger.filter,
            conditions: compiled.conditions.map((c) => ({
              sort_order: c.sort_order,
              field: c.field,
              operator: c.operator as automationService.ConditionOperator,
              value: c.value,
              logic_group: (c.logic_group ?? 'and') as automationService.LogicGroup,
            })),
            actions: compiled.actions.map((a) => ({
              sort_order: a.sort_order,
              mcp_tool: a.mcp_tool,
              parameters: a.parameters as Record<string, unknown> | undefined,
              on_error: (a.on_error ?? 'stop') as automationService.OnError,
              retry_count: a.retry_count ?? 0,
              retry_delay_ms: a.retry_delay_ms ?? 1000,
            })),
          };
        } catch (err) {
          if (err instanceof BoltGraphShapeError) {
            return reply.status(400).send({
              error: { code: 'GRAPH_SHAPE_ERROR', message: err.message },
            });
          }
          throw err;
        }
      }
      // If no graph, clear the graph column so the next GET re-synthesizes it.
      // graphBlob stays null, graphMode stays null.

      // Validate MCP tool names against allowlist (if actions provided)
      if (resolvedData.actions && resolvedData.actions.length > 0) {
        validateActionTools(resolvedData.actions as automationService.ActionInput[]);

        // Lenient mode for updates: warn but allow (don't break existing automations)
        const paramResult = await validateActionParameters(
          resolvedData.actions as automationService.ActionInput[],
          request.user!.org_id,
          'lenient',
        );
        if (!paramResult.valid) {
          request.log.warn(
            { warnings: paramResult.warnings, automationId: (request as any).automation.id },
            'Automation update has cross-org parameter warnings',
          );
        }
      }

      const automation = await automationService.updateAutomation(
        (request as any).automation.id,
        resolvedData,
        request.user!.id,
        request.user!.org_id,
        graphBlob,
        graphMode,
      );
      return reply.send({ data: automation });
    },
  );

  // PATCH /automations/:id — Partial metadata update
  fastify.patch<{ Params: { id: string } }>(
    '/automations/:id',
    { preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = patchAutomationSchema.parse(request.body);
      const automation = await automationService.patchAutomation(
        (request as any).automation.id,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: automation });
    },
  );

  // DELETE /automations/:id
  fastify.delete<{ Params: { id: string } }>(
    '/automations/:id',
    { preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await automationService.deleteAutomation(
        (request as any).automation.id,
        request.user!.org_id,
      );
      return reply.status(204).send();
    },
  );

  // POST /automations/:id/enable
  fastify.post<{ Params: { id: string } }>(
    '/automations/:id/enable',
    { preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation_enable.create'), requireScope('read_write')] },
    async (request, reply) => {
      const automation = await automationService.enableAutomation(
        (request as any).automation.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: automation });
    },
  );

  // POST /automations/:id/disable
  fastify.post<{ Params: { id: string } }>(
    '/automations/:id/disable',
    { preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation_disable.create'), requireScope('read_write')] },
    async (request, reply) => {
      const automation = await automationService.disableAutomation(
        (request as any).automation.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: automation });
    },
  );

  // POST /automations/:id/duplicate
  fastify.post<{ Params: { id: string } }>(
    '/automations/:id/duplicate',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireAutomationAccess(), shadowOnly('bolt.automation.duplicate'), requireScope('read_write')],
    },
    async (request, reply) => {
      const automation = await automationService.duplicateAutomation(
        (request as any).automation.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: automation });
    },
  );

  // POST /automations/:id/test — Test condition evaluation
  fastify.post<{ Params: { id: string } }>(
    '/automations/:id/test',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireAutomationAccess(), shadowOnly('bolt.automation_test.create')],
    },
    async (request, reply) => {
      const { event } = testAutomationSchema.parse(request.body);
      const result = await automationService.testAutomation(
        (request as any).automation.id,
        event,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // ── Automation versioning ─────────────────────────────────────────────

  // GET /automations/:id/versions — List versions for an automation
  fastify.get<{ Params: { id: string } }>(
    '/automations/:id/versions',
    { preHandler: [requireAuth, requireAutomationAccess(), shadowOnly('bolt.automation_version.get')] },
    async (request, reply) => {
      const versions = await automationService.listAutomationVersions(
        (request as any).automation.id,
      );
      return reply.send({ data: versions });
    },
  );

  // POST /automations/:id/versions/:vid/restore — Restore a version
  fastify.post<{ Params: { id: string; vid: string } }>(
    '/automations/:id/versions/:vid/restore',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireAutomationEditAccess(), shadowOnly('bolt.automation_version.restore'), requireScope('read_write')],
    },
    async (request, reply) => {
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_REGEX.test(request.params.vid)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid version id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      const restored = await automationService.restoreAutomationVersion(
        (request as any).automation.id,
        request.params.vid,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: restored });
    },
  );
}
