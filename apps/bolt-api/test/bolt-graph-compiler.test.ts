import { describe, it, expect } from 'vitest';
import {
  compileGraphToRows,
  projectRowsToGraph,
  BoltGraphShapeError,
} from '../src/services/bolt-graph-compiler.js';
import type { BoltGraph } from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(overrides: Partial<BoltGraph> = {}): BoltGraph {
  return {
    version: 1,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

const BASE_TRIGGER_ID = 'node-trigger';
const BASE_CONDITION_ID = 'node-cond-1';
const BASE_ACTION_1_ID = 'node-action-1';
const BASE_ACTION_2_ID = 'node-action-2';

function controlEdge(source: string, target: string) {
  return {
    id: `${source}->${target}`,
    source,
    sourceHandle: 'output',
    target,
    targetHandle: 'input',
  };
}

function dataEdge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
) {
  return {
    id: `data:${source}.${sourceHandle}->${target}.${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe('compileGraphToRows → projectRowsToGraph round-trip', () => {
  it('Event → 1 condition → 2 actions round-trips structurally', () => {
    const graph: BoltGraph = makeGraph({
      nodes: [
        {
          id: BASE_TRIGGER_ID,
          kind: 'trigger',
          position: { x: 0, y: 0 },
          data: { source: 'bam', event: 'task.created', filter: { priority: 'high' } },
        },
        {
          id: BASE_CONDITION_ID,
          kind: 'condition',
          position: { x: 200, y: 0 },
          data: { field: 'event.status', operator: 'equals', value: 'open', logicGroup: 'and' },
        },
        {
          id: BASE_ACTION_1_ID,
          kind: 'action',
          position: { x: 400, y: 0 },
          data: {
            mcpTool: 'create_task',
            parameters: { title: 'Follow-up' },
            onError: 'fail',
            retryCount: 0,
            retryDelayMs: 1000,
          },
        },
        {
          id: BASE_ACTION_2_ID,
          kind: 'action',
          position: { x: 600, y: 0 },
          data: {
            mcpTool: 'add_comment',
            parameters: { body: 'done' },
            onError: 'continue',
            retryCount: 1,
            retryDelayMs: 2000,
          },
        },
      ],
      edges: [
        controlEdge(BASE_TRIGGER_ID, BASE_CONDITION_ID),
        controlEdge(BASE_CONDITION_ID, BASE_ACTION_1_ID),
        controlEdge(BASE_ACTION_1_ID, BASE_ACTION_2_ID),
      ],
    });

    const { trigger, conditions, actions } = compileGraphToRows(graph);

    // --- Verify compiled rows ---
    expect(trigger.source).toBe('bam');
    expect(trigger.event).toBe('task.created');
    expect(trigger.filter).toEqual({ priority: 'high' });

    expect(conditions).toHaveLength(1);
    expect(conditions[0]!.sort_order).toBe(0);
    expect(conditions[0]!.field).toBe('event.status');
    expect(conditions[0]!.operator).toBe('equals');
    expect(conditions[0]!.value).toBe('open');
    expect(conditions[0]!.logic_group).toBe('and');

    expect(actions).toHaveLength(2);
    expect(actions[0]!.sort_order).toBe(0);
    expect(actions[0]!.mcp_tool).toBe('create_task');
    expect(actions[0]!.on_error).toBe('stop'); // 'fail' → 'stop' mapping
    expect(actions[1]!.sort_order).toBe(1);
    expect(actions[1]!.mcp_tool).toBe('add_comment');
    expect(actions[1]!.on_error).toBe('continue');

    // --- Project back ---
    const fakeId = (n: number) => `fake-id-${n}`;
    const projectedGraph = projectRowsToGraph({
      trigger,
      conditions: conditions.map((c, i) => ({
        id: fakeId(i),
        automation_id: 'auto-1',
        created_at: new Date(),
        value: c.value,
        logic_group: c.logic_group!,
        ...c,
      })),
      actions: actions.map((a, i) => ({
        id: fakeId(100 + i),
        automation_id: 'auto-1',
        created_at: new Date(),
        parameters: a.parameters ?? null,
        on_error: a.on_error!,
        retry_count: a.retry_count!,
        retry_delay_ms: a.retry_delay_ms!,
        ...a,
      })),
    });

    // Structural equality: same kinds in same order
    expect(projectedGraph.version).toBe(1);
    const kinds = projectedGraph.nodes.map((n) => n.kind);
    expect(kinds).toEqual(['trigger', 'condition', 'action', 'action']);

    // Trigger data preserved
    const tNode = projectedGraph.nodes.find((n) => n.kind === 'trigger')!;
    expect(tNode.data).toMatchObject({ source: 'bam', event: 'task.created' });

    // Condition data preserved
    const cNode = projectedGraph.nodes.find((n) => n.kind === 'condition')!;
    expect(cNode.data).toMatchObject({ field: 'event.status', operator: 'equals' });

    // Control-flow edges: trigger→condition, condition→action1, action1→action2
    const controlEdges = projectedGraph.edges.filter(
      (e) => e.sourceHandle === 'output' && e.targetHandle === 'input',
    );
    expect(controlEdges).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Wire round-trip test
// ---------------------------------------------------------------------------

describe('data-flow wire round-trip', () => {
  it('action[0].result-task_id → action[1].param-task_id compiles to template string', () => {
    const graph: BoltGraph = makeGraph({
      nodes: [
        {
          id: BASE_TRIGGER_ID,
          kind: 'trigger',
          position: { x: 0, y: 0 },
          data: { source: 'bam', event: 'task.created', filter: {} },
        },
        {
          id: BASE_ACTION_1_ID,
          kind: 'action',
          position: { x: 200, y: 0 },
          data: {
            mcpTool: 'create_task',
            parameters: { title: 'Follow-up' },
            onError: 'fail',
            retryCount: 0,
            retryDelayMs: 1000,
          },
        },
        {
          id: BASE_ACTION_2_ID,
          kind: 'action',
          position: { x: 400, y: 0 },
          data: {
            mcpTool: 'add_comment',
            parameters: {},
            onError: 'fail',
            retryCount: 0,
            retryDelayMs: 1000,
          },
        },
      ],
      edges: [
        controlEdge(BASE_TRIGGER_ID, BASE_ACTION_1_ID),
        controlEdge(BASE_ACTION_1_ID, BASE_ACTION_2_ID),
        dataEdge(BASE_ACTION_1_ID, 'result-task_id', BASE_ACTION_2_ID, 'param-task_id'),
      ],
    });

    const { actions } = compileGraphToRows(graph);

    expect(actions).toHaveLength(2);
    expect(actions[1]!.parameters).toMatchObject({
      task_id: '{{ step[0].result.task_id }}',
    });
  });

  it('project back: template string in action[1] → data-flow edge reconstructed', () => {
    const trigger = { source: 'bam', event: 'task.created', filter: {} };
    const conditions: any[] = [];
    const actions: any[] = [
      {
        id: 'a-0',
        automation_id: 'auto-1',
        sort_order: 0,
        mcp_tool: 'create_task',
        parameters: { title: 'Follow-up' },
        on_error: 'stop',
        retry_count: 0,
        retry_delay_ms: 1000,
        created_at: new Date(),
      },
      {
        id: 'a-1',
        automation_id: 'auto-1',
        sort_order: 1,
        mcp_tool: 'add_comment',
        // Template string from compile step
        parameters: { task_id: '{{ step[0].result.task_id }}' },
        on_error: 'stop',
        retry_count: 0,
        retry_delay_ms: 1000,
        created_at: new Date(),
      },
    ];

    const graph = projectRowsToGraph({ trigger, conditions, actions });

    // Data-flow edge should be present
    const dataFlowEdge = graph.edges.find(
      (e) => e.sourceHandle === 'result-task_id' && e.targetHandle === 'param-task_id',
    );
    expect(dataFlowEdge).toBeDefined();
    expect(dataFlowEdge!.source).toContain('a-0');
    expect(dataFlowEdge!.target).toContain('a-1');

    // task_id should NOT appear in action[1]'s parameters (replaced by edge)
    const action1Node = graph.nodes.find(
      (n) => n.kind === 'action' && (n.data as any).mcpTool === 'add_comment',
    )!;
    expect((action1Node.data as any).parameters).not.toHaveProperty('task_id');
  });
});

// ---------------------------------------------------------------------------
// Shape failure
// ---------------------------------------------------------------------------

describe('compileGraphToRows — shape failure', () => {
  it('throws BoltGraphShapeError for graph with two trigger nodes', () => {
    const graph: BoltGraph = makeGraph({
      nodes: [
        {
          id: 't1',
          kind: 'trigger',
          position: { x: 0, y: 0 },
          data: { source: 'bam', event: 'task.created', filter: {} },
        },
        {
          id: 't2',
          kind: 'trigger',
          position: { x: 0, y: 200 },
          data: { source: 'banter', event: 'message.posted', filter: {} },
        },
        {
          id: 'a1',
          kind: 'action',
          position: { x: 200, y: 0 },
          data: { mcpTool: 'create_task', parameters: {}, onError: 'fail', retryCount: 0, retryDelayMs: 1000 },
        },
      ],
      edges: [
        controlEdge('t1', 'a1'),
      ],
    });

    expect(() => compileGraphToRows(graph)).toThrow(BoltGraphShapeError);
    expect(() => compileGraphToRows(graph)).toThrow(/2 trigger nodes/);
  });
});
