import type {
  BoltGraph,
  BoltGraphNode,
  TriggerNodeData,
  ConditionNodeData,
  ActionNodeData,
} from '@bigbluebam/shared';
import { isSimpleShape } from '@bigbluebam/shared';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type { boltConditions, boltActions } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Row types derived from Drizzle schemas
// ---------------------------------------------------------------------------

export type NewBoltCondition = InferInsertModel<typeof boltConditions>;
export type BoltCondition = InferSelectModel<typeof boltConditions>;
export type NewBoltAction = InferInsertModel<typeof boltActions>;
export type BoltAction = InferSelectModel<typeof boltActions>;

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class BoltGraphShapeError extends Error {
  constructor(reason: string) {
    super(`Graph shape check failed: ${reason}`);
    this.name = 'BoltGraphShapeError';
  }
}

// ---------------------------------------------------------------------------
// Template pattern — mirrors template-resolver.ts:87-94
// ---------------------------------------------------------------------------

/**
 * Pattern used by the template resolver to dereference step outputs.
 * Matches `{{ step[N].result.FIELD }}` — same regex as
 * `template-resolver.ts:STEP_REGEX`.
 *
 * Uses non-greedy `(.+?)` so that trailing whitespace before `}}` is not
 * captured as part of the field name.
 */
const STEP_TEMPLATE_RE = /^\{\{\s*step\[(\d+)\]\.result\.(.+?)\s*\}\}$/;

function makeStepTemplate(sortOrder: number, field: string): string {
  return `{{ step[${sortOrder}].result.${field} }}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an edge is a control-flow edge (not a data-flow edge).
 * Mirrors the logic in bolt-graph-shape.ts so the compiler agrees with the
 * shape checker.
 */
function isControlEdge(
  edge: BoltGraph['edges'][0],
  nodeKindById: Map<string, BoltGraphNode['kind']>,
): boolean {
  const srcKind = nodeKindById.get(edge.source);
  if (!srcKind || srcKind !== 'action') return true;
  if (edge.sourceHandle === 'output') return true;
  if (edge.targetHandle === 'input' || edge.targetHandle.startsWith('control')) return true;
  return false;
}

/**
 * Topologically order nodes in the simple linear shape, starting from the
 * trigger node and following control-flow edges only.
 */
function topoOrder(graph: BoltGraph): BoltGraphNode[] {
  const nodeMap = new Map<string, BoltGraphNode>(graph.nodes.map((n) => [n.id, n]));
  const kindById = new Map<string, BoltGraphNode['kind']>(graph.nodes.map((n) => [n.id, n.kind]));

  const controlSuccessor = new Map<string, string>();
  for (const edge of graph.edges) {
    if (isControlEdge(edge, kindById)) {
      controlSuccessor.set(edge.source, edge.target);
    }
  }

  const trigger = graph.nodes.find((n) => n.kind === 'trigger')!;
  const ordered: BoltGraphNode[] = [];
  let current: BoltGraphNode | undefined = trigger;

  while (current) {
    ordered.push(current);
    const nextId = controlSuccessor.get(current.id);
    current = nextId ? nodeMap.get(nextId) : undefined;
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// compileGraphToRows
// ---------------------------------------------------------------------------

/**
 * Compile a BoltGraph into the relational rows that the automation service
 * persists. Throws `BoltGraphShapeError` if the graph is not a simple shape.
 *
 * Note: `automation_id` is intentionally omitted from the returned rows —
 * the caller (route handler / service) fills it in before inserting.
 */
export function compileGraphToRows(graph: BoltGraph): {
  trigger: { source: string; event: string; filter: Record<string, unknown> };
  conditions: Omit<NewBoltCondition, 'automation_id'>[];
  actions: Omit<NewBoltAction, 'automation_id'>[];
} {
  const check = isSimpleShape(graph);
  if (!check.ok) {
    throw new BoltGraphShapeError(check.reason);
  }

  const ordered = topoOrder(graph);
  const kindById = new Map<string, BoltGraphNode['kind']>(graph.nodes.map((n) => [n.id, n.kind]));

  // --- Trigger ---
  const triggerNode = ordered[0]!;
  const triggerData = triggerNode.data as unknown as TriggerNodeData;
  const trigger = {
    source: triggerData.source ?? '',
    event: triggerData.event ?? '',
    filter: triggerData.filter ?? {},
  };

  // --- Conditions ---
  const conditionNodes = ordered.filter((n) => n.kind === 'condition');
  const conditions: Omit<NewBoltCondition, 'automation_id'>[] = conditionNodes.map((node, idx) => {
    const d = node.data as unknown as ConditionNodeData;
    return {
      sort_order: idx,
      field: d.field ?? '',
      operator: (d.operator as NewBoltCondition['operator']) ?? 'equals',
      value: d.value ?? null,
      logic_group: (d.logicGroup as NewBoltCondition['logic_group']) ?? 'and',
    };
  });

  // --- Actions ---
  //
  // Build an index from nodeId → sort_order for action nodes (used when
  // resolving data-flow edges to template strings).
  const actionNodes = ordered.filter((n) => n.kind === 'action');
  const actionSortOrderById = new Map<string, number>(
    actionNodes.map((n, idx) => [n.id, idx]),
  );

  // Build data-flow edge map: targetNodeId → Map<paramHandle, {srcNodeId, srcHandle}>
  const dataEdges = new Map<string, Map<string, { srcId: string; srcHandle: string }>>();
  for (const edge of graph.edges) {
    if (!isControlEdge(edge, kindById)) {
      if (!dataEdges.has(edge.target)) {
        dataEdges.set(edge.target, new Map());
      }
      dataEdges.get(edge.target)!.set(edge.targetHandle, {
        srcId: edge.source,
        srcHandle: edge.sourceHandle,
      });
    }
  }

  const actions: Omit<NewBoltAction, 'automation_id'>[] = actionNodes.map((node, idx) => {
    const d = node.data as unknown as ActionNodeData;
    const baseParams: Record<string, unknown> = { ...(d.parameters ?? {}) };

    // Overlay data-flow edges as template strings.
    const wiredParams = dataEdges.get(node.id);
    if (wiredParams) {
      for (const [paramHandle, { srcId, srcHandle }] of wiredParams) {
        const srcSortOrder = actionSortOrderById.get(srcId);
        if (srcSortOrder !== undefined) {
          // Derive the field name from the source handle. Convention used by
          // the graph editor: source handles are named "result-<fieldName>".
          // Strip the "result-" prefix if present; otherwise use as-is.
          const field = srcHandle.startsWith('result-')
            ? srcHandle.slice('result-'.length)
            : srcHandle;
          // Derive the param key from the target handle. Convention: "param-<key>".
          const paramKey = paramHandle.startsWith('param-')
            ? paramHandle.slice('param-'.length)
            : paramHandle;
          baseParams[paramKey] = makeStepTemplate(srcSortOrder, field);
        }
      }
    }

    return {
      sort_order: idx,
      mcp_tool: d.mcpTool ?? '',
      parameters: Object.keys(baseParams).length > 0 ? baseParams : null,
      on_error: (() => {
        // Map ActionNodeData.onError ('fail'|'continue'|'retry') to DB enum
        // ('stop'|'continue'|'retry'). The graph editor uses 'fail'; the DB uses 'stop'.
        if (d.onError === 'fail') return 'stop' as const;
        if (d.onError === 'continue') return 'continue' as const;
        if (d.onError === 'retry') return 'retry' as const;
        return 'stop' as const;
      })(),
      retry_count: d.retryCount ?? 0,
      retry_delay_ms: d.retryDelayMs ?? 1000,
    };
  });

  return { trigger, conditions, actions };
}

// ---------------------------------------------------------------------------
// projectRowsToGraph
// ---------------------------------------------------------------------------

/**
 * Inverse of compileGraphToRows. Synthesizes a BoltGraph from relational
 * rows. Used to populate the `graph` field on read when the DB column is null
 * (i.e. for legacy automations created before the graph editor existed).
 *
 * Layout: left-to-right, nodes spaced 200px apart, all vertically centered at y=300.
 */
export function projectRowsToGraph(rows: {
  trigger: { source: string; event: string; filter: Record<string, unknown> };
  conditions: BoltCondition[];
  actions: BoltAction[];
}): BoltGraph {
  const { trigger, conditions, actions } = rows;

  const sortedConditions = [...conditions].sort((a, b) => a.sort_order - b.sort_order);
  const sortedActions = [...actions].sort((a, b) => a.sort_order - b.sort_order);

  const nodes: BoltGraph['nodes'] = [];
  const edges: BoltGraph['edges'] = [];

  const NODE_SPACING_X = 200;
  const CENTER_Y = 300;
  let xCursor = 0;

  // --- Trigger node ---
  const triggerId = 'node-trigger';
  nodes.push({
    id: triggerId,
    kind: 'trigger',
    position: { x: xCursor, y: CENTER_Y },
    data: {
      source: trigger.source,
      event: trigger.event,
      filter: trigger.filter,
    } satisfies TriggerNodeData,
  });
  xCursor += NODE_SPACING_X;

  let prevNodeId = triggerId;

  // --- Condition nodes ---
  for (const cond of sortedConditions) {
    const nodeId = `node-condition-${cond.id}`;
    nodes.push({
      id: nodeId,
      kind: 'condition',
      position: { x: xCursor, y: CENTER_Y },
      data: {
        field: cond.field,
        operator: cond.operator,
        value: cond.value,
        logicGroup: cond.logic_group,
      } satisfies ConditionNodeData,
    });
    edges.push({
      id: `edge-${prevNodeId}->${nodeId}`,
      source: prevNodeId,
      sourceHandle: 'output',
      target: nodeId,
      targetHandle: 'input',
    });
    prevNodeId = nodeId;
    xCursor += NODE_SPACING_X;
  }

  // --- Action nodes ---
  const actionNodeIds: string[] = [];
  for (const action of sortedActions) {
    const nodeId = `node-action-${action.id}`;
    actionNodeIds.push(nodeId);

    // Parse parameters and extract data-flow wired values.
    const rawParams = (action.parameters ?? {}) as Record<string, unknown>;
    const projectedParams: Record<string, unknown> = {};
    const dataFlowEdgesToEmit: Array<{
      srcSortOrder: number;
      field: string;
      paramKey: string;
    }> = [];

    for (const [key, value] of Object.entries(rawParams)) {
      if (typeof value === 'string') {
        const match = value.match(STEP_TEMPLATE_RE);
        if (match) {
          // This parameter was wired from a previous action's output.
          const srcSortOrder = Number.parseInt(match[1]!, 10);
          const field = match[2]!;
          // Don't include the template string in the param — the edge replaces it.
          dataFlowEdgesToEmit.push({ srcSortOrder, field, paramKey: key });
          continue; // omit from parameters (replaced by edge visually)
        }
      }
      projectedParams[key] = value;
    }

    nodes.push({
      id: nodeId,
      kind: 'action',
      position: { x: xCursor, y: CENTER_Y },
      data: {
        mcpTool: action.mcp_tool,
        parameters: projectedParams,
        onError: action.on_error === 'stop' ? 'fail' : action.on_error,
        retryCount: action.retry_count,
        retryDelayMs: action.retry_delay_ms,
      } satisfies ActionNodeData,
    });

    // Control-flow edge
    edges.push({
      id: `edge-${prevNodeId}->${nodeId}`,
      source: prevNodeId,
      sourceHandle: 'output',
      target: nodeId,
      targetHandle: 'input',
    });
    prevNodeId = nodeId;
    xCursor += NODE_SPACING_X;

    // Data-flow edges (emitted after the node is registered)
    for (const { srcSortOrder, field, paramKey } of dataFlowEdgesToEmit) {
      const srcNodeId = actionNodeIds[srcSortOrder];
      if (srcNodeId) {
        edges.push({
          id: `edge-data-${srcNodeId}.result-${field}->${nodeId}.param-${paramKey}`,
          source: srcNodeId,
          sourceHandle: `result-${field}`,
          target: nodeId,
          targetHandle: `param-${paramKey}`,
        });
      }
    }
  }

  return {
    version: 1,
    nodes,
    edges,
  };
}
