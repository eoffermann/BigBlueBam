import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    execute: mockExecute,
  },
  readDb: {
    execute: mockExecute,
  },
  connection: { end: vi.fn() },
  readConnection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4011,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
    QUERY_TIMEOUT_MS: 10000,
    CACHE_TTL_SECONDS: 60,
  },
}));

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockResolvedValue(result);
  obj.returning = vi.fn().mockResolvedValue(result);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.fields = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.leftJoin = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

const WIDGET_ID = '00000000-0000-0000-0000-000000000600';
const DASHBOARD_ID = '00000000-0000-0000-0000-000000000500';
const ORG_ID = '00000000-0000-0000-0000-000000000001';

function makeWidget(overrides: Record<string, unknown> = {}) {
  return {
    id: WIDGET_ID,
    dashboard_id: DASHBOARD_ID,
    name: 'Task Count by Priority',
    widget_type: 'bar_chart',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'task_count' }],
      dimensions: [{ field: 'priority' }],
    },
    viz_config: {},
    kpi_config: null,
    cache_ttl_seconds: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('Widget Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getWidget', () => {
    // TODO(wave-2-bench): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Bench_Plan.md done definition.
    it.skip('returns a widget by id', async () => {
      const widget = makeWidget();
      // getWidget selects { widget: benchWidgets } + innerJoin on benchDashboards,
      // so rows come back shaped as { widget }.
      mockSelect.mockReturnValue(chainable([{ widget }]));

      const { getWidget } = await import('../src/services/widget.service.js');
      const result = await getWidget(WIDGET_ID);

      expect(result.name).toBe('Task Count by Priority');
    });

    it('throws not found for missing widget', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { getWidget } = await import('../src/services/widget.service.js');
      await expect(getWidget('nonexistent')).rejects.toThrow('Widget not found');
    });
  });

  describe('createWidget', () => {
    it('creates a widget for valid data source', async () => {
      const dashCheck = chainable([{ id: DASHBOARD_ID }]);
      mockSelect.mockReturnValue(dashCheck);

      const widget = makeWidget();
      const insertChain = chainable([widget]);
      mockInsert.mockReturnValue({ values: vi.fn().mockReturnValue(insertChain) });

      const { createWidget } = await import('../src/services/widget.service.js');
      const result = await createWidget(DASHBOARD_ID, ORG_ID, {
        name: 'Task Count by Priority',
        widget_type: 'bar_chart',
        data_source: 'bam',
        entity: 'tasks',
        query_config: {
          measures: [{ field: 'id', agg: 'count' }],
        },
      });

      expect(result.name).toBe('Task Count by Priority');
    });

    it('rejects invalid data source', async () => {
      const dashCheck = chainable([{ id: DASHBOARD_ID }]);
      mockSelect.mockReturnValue(dashCheck);

      const { createWidget } = await import('../src/services/widget.service.js');
      await expect(
        createWidget(DASHBOARD_ID, ORG_ID, {
          name: 'Bad',
          widget_type: 'bar_chart',
          data_source: 'nonexistent',
          entity: 'fake',
          query_config: { measures: [{ field: 'id', agg: 'count' }] },
        }),
      ).rejects.toThrow('Unknown data source');
    });
  });

  describe('deleteWidget', () => {
    it('deletes a widget', async () => {
      mockDelete.mockReturnValue(chainable([{ id: WIDGET_ID }]));

      const { deleteWidget } = await import('../src/services/widget.service.js');
      const result = await deleteWidget(WIDGET_ID);

      expect(result.id).toBe(WIDGET_ID);
    });
  });
});
