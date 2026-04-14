import { z } from 'zod';

// NOTE: The Bolt node-graph authoring model lives in
// `packages/shared/src/bolt-graph.ts` and `bolt-graph-shape.ts`. Those files
// define the structural/graph types used by the compiler and the React Flow
// editor. This schema file covers the HTTP-facing CRUD surface of the Bolt
// REST API: automations, executions, templates, AI assist, and the
// /v1/events/ingest body shape.

// ── Enums ──────────────────────────────────────────────────────────────
export const BoltTriggerSource = z.enum([
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
]);

export const BoltConditionOperator = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
  'in',
  'not_in',
  'matches_regex',
]);

export const BoltLogicGroup = z.enum(['and', 'or']);
export const BoltNodeKindSchema = z.enum(['trigger', 'condition', 'action']);
export const BoltActorTypeSchema = z.enum(['user', 'agent', 'system']);

// ── Graph (thin wire schema, full types in bolt-graph.ts) ──────────────
export const boltGraphNodeWireSchema = z.object({
  id: z.string().min(1),
  kind: BoltNodeKindSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.unknown()),
});

export const boltGraphEdgeWireSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1),
  target: z.string().min(1),
  targetHandle: z.string().min(1),
});

export const boltGraphWireSchema = z.object({
  version: z.literal(1),
  nodes: z.array(boltGraphNodeWireSchema),
  edges: z.array(boltGraphEdgeWireSchema),
});

// ── Automation condition/action rows ───────────────────────────────────
export const boltAutomationConditionSchema = z.object({
  sort_order: z.number().int().min(0).max(100),
  field: z.string().min(1).max(255),
  operator: BoltConditionOperator,
  value: z.unknown().optional(),
  logic_group: BoltLogicGroup.optional().default('and'),
});

export const boltAutomationActionSchema = z.object({
  sort_order: z.number().int().min(0).max(100),
  mcp_tool: z.string().min(1).max(100),
  parameters: z.record(z.unknown()).optional(),
});

// ── Automation schemas ─────────────────────────────────────────────────
export const createBoltAutomationSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).nullable().optional(),
    project_id: z.string().uuid().nullable().optional(),
    enabled: z.boolean().optional().default(true),
    trigger_source: BoltTriggerSource,
    trigger_event: z.string().min(1).max(60),
    trigger_filter: z.record(z.unknown()).nullable().optional(),
    cron_expression: z.string().max(100).nullable().optional(),
    cron_timezone: z.string().max(50).optional().default('UTC'),
    max_executions_per_hour: z.number().int().min(1).max(10000).optional().default(100),
    cooldown_seconds: z.number().int().min(0).max(86400).optional().default(0),
    conditions: z.array(boltAutomationConditionSchema).max(50).optional().default([]),
    actions: z.array(boltAutomationActionSchema).min(1).max(50).optional(),
    graph: boltGraphWireSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.graph && (!data.actions || data.actions.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Automation must provide either a graph or at least one action',
        path: ['actions'],
      });
    }
  });

export const updateBoltAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
  trigger_source: BoltTriggerSource.optional(),
  trigger_event: z.string().min(1).max(60).optional(),
  trigger_filter: z.record(z.unknown()).nullable().optional(),
  cron_expression: z.string().max(100).nullable().optional(),
  cron_timezone: z.string().max(50).optional(),
  max_executions_per_hour: z.number().int().min(1).max(10000).optional(),
  cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  conditions: z.array(boltAutomationConditionSchema).max(50).optional(),
  actions: z.array(boltAutomationActionSchema).min(1).max(50).optional(),
  graph: boltGraphWireSchema.optional(),
});

export const patchBoltAutomationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  enabled: z.boolean().optional(),
});

export const listBoltAutomationsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  trigger_source: z.string().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const testBoltAutomationSchema = z.object({
  event: z.record(z.unknown()),
});

// ── Execution schemas ──────────────────────────────────────────────────
export const listBoltExecutionsQuerySchema = z.object({
  status: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── Template schemas ───────────────────────────────────────────────────
export const instantiateBoltTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  cron_expression: z.string().max(100).nullable().optional(),
  cron_timezone: z.string().max(50).optional(),
});

// ── Event ingest schemas ───────────────────────────────────────────────
export const boltEventIngestSchema = z.object({
  event_type: z.string().min(1).max(60),
  source: BoltTriggerSource,
  payload: z.record(z.unknown()),
  org_id: z.string().uuid(),
  project_id: z.string().uuid().optional(),
  actor_id: z.string().uuid().optional(),
  actor_type: BoltActorTypeSchema.optional(),
  chain_depth: z.number().int().min(0).max(100).optional().default(0),
});

// ── AI assist schemas ──────────────────────────────────────────────────
export const boltAiGenerateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  context: z.record(z.unknown()).optional(),
  project_id: z.string().uuid().optional(),
});

export const boltAiExplainSchema = z.object({
  automation: z.object({
    name: z.string().max(255),
    trigger_source: z.string().max(30),
    trigger_event: z.string().max(60),
    conditions: z.array(z.record(z.unknown())).optional().default([]),
    actions: z.array(z.record(z.unknown())).optional().default([]),
  }),
  project_id: z.string().uuid().optional(),
});
