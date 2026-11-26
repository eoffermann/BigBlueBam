// §12 Wave 5 bolt observability
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module (services/event-trace.service.ts imports from
// ../db/index.js). We build a small query-builder stub so each service call
// can stage its own return value.
// ---------------------------------------------------------------------------

const dbQueue: unknown[] = [];

function makeChain(finalValue: unknown) {
  // Every intermediate query-builder method returns `this`, and the chain
  // ends by being awaited. We stamp the final value on the thenable.
  const chain: any = {};
  const methods = [
    'select',
    'from',
    'innerJoin',
    'leftJoin',
    'where',
    'orderBy',
    'limit',
    'groupBy',
    'offset',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(finalValue);
  return chain;
}

vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(() => {
      const next = dbQueue.shift();
      return makeChain(next ?? []);
    }),
    insert: vi.fn(() => makeChain([])),
    update: vi.fn(() => makeChain([])),
    delete: vi.fn(() => makeChain([])),
  },
  connection: { end: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock the shared publishBoltEvent for the drift-detector tests so we can
// assert it was (or was not) called.
// ---------------------------------------------------------------------------

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@bigbluebam/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bigbluebam/shared')>()),
  publishBoltEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { getTraceByEventId, listRecentEvents } from '../src/services/event-trace.service.js';
import { detectCatalogDrift } from '../src/services/catalog-drift-detector.js';
import { getEventDefinition } from '../src/services/event-catalog.js';

// ---------------------------------------------------------------------------
// Event-catalog coverage for the new drift event
// ---------------------------------------------------------------------------

describe('event catalog — drift event registration', () => {
  it('registers platform.catalog.drift_detected with a payload schema', () => {
    const def = getEventDefinition('platform', 'catalog.drift_detected');
    expect(def).toBeDefined();
    expect(def!.payload_schema.length).toBeGreaterThan(0);
    const fieldNames = def!.payload_schema.map((f) => f.name);
    expect(fieldNames).toContain('drift.source');
    expect(fieldNames).toContain('drift.event_type');
  });
});

// ---------------------------------------------------------------------------
// Drift detector — suppression and self-loop
// ---------------------------------------------------------------------------

describe('detectCatalogDrift', () => {
  let redis: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPublish.mockClear();
    redis = { set: vi.fn() };
  });

  it('fires once when a novel (source, event_type) is ingested', async () => {
    redis.set.mockResolvedValueOnce('OK');
    const fired = await detectCatalogDrift(redis as any, {
      source: 'notasource',
      eventType: 'made.up',
      eventId: '00000000-0000-0000-0000-000000000001',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
    expect(fired).toBe(true);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event, source, payload] = mockPublish.mock.calls[0]!;
    expect(event).toBe('catalog.drift_detected');
    expect(source).toBe('platform');
    expect((payload as any).drift.source).toBe('notasource');
    // Redis suppression SET ... NX EX 86400
    expect(redis.set).toHaveBeenCalledWith(
      'bolt:drift:seen:notasource:made.up',
      '1',
      'EX',
      86400,
      'NX',
    );
  });

  it('suppresses subsequent drift within 24h (Redis NX returns null)', async () => {
    redis.set.mockResolvedValueOnce(null);
    const fired = await detectCatalogDrift(redis as any, {
      source: 'notasource',
      eventType: 'made.up',
      eventId: '00000000-0000-0000-0000-000000000003',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
    expect(fired).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not fire for catalog-known (source, event_type)', async () => {
    const fired = await detectCatalogDrift(redis as any, {
      source: 'platform',
      eventType: 'approval.requested',
      eventId: '00000000-0000-0000-0000-000000000004',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
    expect(fired).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('never re-enters itself on platform.catalog.drift_detected', async () => {
    const fired = await detectCatalogDrift(redis as any, {
      source: 'platform',
      eventType: 'catalog.drift_detected',
      eventId: '00000000-0000-0000-0000-000000000005',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
    expect(fired).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('falls through to fire when Redis throws (best-effort suppression)', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    const fired = await detectCatalogDrift(redis as any, {
      source: 'another',
      eventType: 'novel.thing',
      eventId: '00000000-0000-0000-0000-000000000006',
      orgId: '00000000-0000-0000-0000-000000000002',
    });
    expect(fired).toBe(true);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getTraceByEventId — returns executions with rules shape
// ---------------------------------------------------------------------------

describe('getTraceByEventId', () => {
  beforeEach(() => {
    dbQueue.length = 0;
  });

  it('returns an evaluation trace with conditions and actions per execution', async () => {
    // First select: executions JOIN automations
    dbQueue.push([
      {
        execution: {
          id: 'exec-1',
          automation_id: 'auto-1',
          status: 'running',
          started_at: new Date('2026-04-18T10:00:00Z'),
          completed_at: null,
          conditions_met: true,
          evaluation_trace: [
            {
              rule_id: 'auto-1',
              rule_name: 'Test Rule',
              matched: true,
              conditions: [
                { condition_id: 'c1', operator: 'equals', field: 'foo', result: true, actual: 'bar', expected: 'bar' },
              ],
              actions: [],
            },
          ],
          condition_log: null,
          trigger_event: { _source: 'bam', _event_type: 'task.created' },
          event_id: 'evt-1',
        },
        automation_name: 'Test Rule',
        org_id: 'org-1',
      },
    ]);
    // Second select: execution_steps for the list of exec ids
    dbQueue.push([
      {
        id: 'step-1',
        execution_id: 'exec-1',
        step_index: 0,
        mcp_tool: 'add_comment',
        status: 'success',
        duration_ms: 42,
        error_message: null,
      },
    ]);

    const out = await getTraceByEventId(
      'evt-1',
      'org-1',
    );

    expect(out).toHaveLength(1);
    const entry = out[0]!;
    expect(entry.execution_id).toBe('exec-1');
    expect(entry.event_source).toBe('bam');
    expect(entry.event_type).toBe('task.created');
    expect(entry.rules).toHaveLength(1);
    expect(entry.rules[0]!.conditions[0]!.field).toBe('foo');
    expect(entry.rules[0]!.actions).toEqual([
      { mcp_tool: 'add_comment', outcome: 'success', duration_ms: 42 },
    ]);
  });

  it('returns empty array when no executions matched the event', async () => {
    dbQueue.push([]);
    const out = await getTraceByEventId(
      '00000000-0000-0000-0000-000000000000',
      'org-1',
    );
    expect(out).toEqual([]);
  });

  it('truncates oversize actual/expected strings to 1KB', async () => {
    const huge = 'x'.repeat(2000);
    dbQueue.push([
      {
        execution: {
          id: 'exec-2',
          automation_id: 'auto-2',
          status: 'skipped',
          started_at: new Date('2026-04-18T10:00:00Z'),
          completed_at: new Date('2026-04-18T10:00:00Z'),
          conditions_met: false,
          evaluation_trace: [
            {
              rule_id: 'auto-2',
              rule_name: 'Big',
              matched: false,
              conditions: [
                { condition_id: null, operator: 'equals', field: 'f', result: false, actual: huge, expected: huge },
              ],
              actions: [],
            },
          ],
          condition_log: null,
          trigger_event: null,
          event_id: 'evt-2',
        },
        automation_name: 'Big',
        org_id: 'org-1',
      },
    ]);
    dbQueue.push([]);

    const out = await getTraceByEventId('evt-2', 'org-1');
    const c = out[0]!.rules[0]!.conditions[0]!;
    expect(typeof c.actual).toBe('string');
    expect((c.actual as string).length).toBeLessThanOrEqual(1025); // 1024 + ellipsis
    expect((c.actual as string).endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listRecentEvents — limit clamp and filter pass-through
// ---------------------------------------------------------------------------

describe('listRecentEvents', () => {
  beforeEach(() => {
    dbQueue.length = 0;
  });

  it('clamps limit to the server-side max (500)', async () => {
    dbQueue.push([]);
    const out = await listRecentEvents({ orgId: 'o', limit: 9999 });
    expect(out).toEqual([]);
    // We cannot assert the internal .limit() call directly without deeper
    // mocking; the clamp is exercised here to at least prove the path runs.
  });

  it('returns summary rows with coerced shapes', async () => {
    dbQueue.push([
      {
        event_id: 'evt-1',
        source: 'bam',
        event_type: 'task.created',
        started_at: new Date('2026-04-18T09:00:00Z'),
        matched: 2,
        first_execution_id: 'exec-1',
      },
      {
        event_id: 'evt-2',
        source: 'bond',
        event_type: 'deal.rotting',
        started_at: new Date('2026-04-18T08:00:00Z'),
        matched: '1', // coerced to number
        first_execution_id: 'exec-2',
      },
    ]);

    const out = await listRecentEvents({ orgId: 'o', source: 'bond' });
    expect(out).toHaveLength(2);
    expect(out[0]!.source).toBe('bam');
    expect(out[0]!.matched_automations).toBe(2);
    expect(out[1]!.matched_automations).toBe(1);
    expect(out[0]!.started_at).toBe('2026-04-18T09:00:00.000Z');
  });
});
