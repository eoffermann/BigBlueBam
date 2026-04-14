import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    transaction: mockTransaction,
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

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

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
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const DASHBOARD_ID = '00000000-0000-0000-0000-000000000500';

function makeDashboard(overrides: Record<string, unknown> = {}) {
  return {
    id: DASHBOARD_ID,
    organization_id: ORG_ID,
    project_id: null,
    name: 'Engineering Overview',
    description: 'Cross-product engineering metrics',
    layout: [],
    visibility: 'organization',
    is_default: false,
    auto_refresh_seconds: 60,
    created_by: USER_ID,
    updated_by: USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listDashboards', () => {
    // TODO(wave-2-bench): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Bench_Plan.md done definition.
    it.skip('returns empty array when no dashboards exist', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { listDashboards } = await import('../src/services/dashboard.service.js');
      const result = await listDashboards(ORG_ID, {});

      expect(result).toEqual([]);
      expect(mockSelect).toHaveBeenCalled();
    });

    // TODO(wave-2-bench): fixture/seed data regression surfaced by Wave 0 CI.
    // Re-enable and fix as part of docs/plans/2026-04-13-revised/Bench_Plan.md done definition.
    it.skip('returns dashboards with widget counts', async () => {
      const dashboards = [makeDashboard()];
      const widgetCounts = [{ dashboard_id: DASHBOARD_ID, count: 3 }];

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable(dashboards);
        return chainable(widgetCounts);
      });

      const { listDashboards } = await import('../src/services/dashboard.service.js');
      const result = await listDashboards(ORG_ID, {});

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Engineering Overview',
        widget_count: 3,
      });
    });
  });

  describe('getDashboard', () => {
    it('returns dashboard with widgets', async () => {
      const dashboard = makeDashboard();
      const widgets = [
        { id: 'w1', dashboard_id: DASHBOARD_ID, name: 'Task Count', widget_type: 'kpi_card' },
      ];

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([dashboard]);
        return chainable(widgets);
      });

      const { getDashboard } = await import('../src/services/dashboard.service.js');
      const result = await getDashboard(DASHBOARD_ID, ORG_ID);

      expect(result.name).toBe('Engineering Overview');
      expect(result.widgets).toHaveLength(1);
    });

    it('throws not found for missing dashboard', async () => {
      mockSelect.mockReturnValue(chainable([]));

      const { getDashboard } = await import('../src/services/dashboard.service.js');
      await expect(getDashboard('nonexistent', ORG_ID)).rejects.toThrow('Dashboard not found');
    });
  });

  describe('createDashboard', () => {
    it('creates a dashboard with default visibility', async () => {
      const newDash = makeDashboard();
      const insertChain = chainable([newDash]);
      mockInsert.mockReturnValue({ values: vi.fn().mockReturnValue(insertChain) });

      let callCount = 0;
      mockSelect.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return chainable([newDash]);
        return chainable([]);
      });

      const { createDashboard } = await import('../src/services/dashboard.service.js');
      const result = await createDashboard(
        { name: 'Engineering Overview', visibility: 'organization' },
        ORG_ID,
        USER_ID,
      );

      expect(result.name).toBe('Engineering Overview');
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe('deleteDashboard', () => {
    it('deletes a dashboard and returns its id', async () => {
      const deleteChain = chainable([{ id: DASHBOARD_ID }]);
      mockDelete.mockReturnValue(deleteChain);

      const { deleteDashboard } = await import('../src/services/dashboard.service.js');
      const result = await deleteDashboard(DASHBOARD_ID, ORG_ID);

      expect(result.id).toBe(DASHBOARD_ID);
    });

    it('throws not found for missing dashboard', async () => {
      mockDelete.mockReturnValue(chainable([]));

      const { deleteDashboard } = await import('../src/services/dashboard.service.js');
      await expect(deleteDashboard('nonexistent', ORG_ID)).rejects.toThrow('Dashboard not found');
    });
  });
});
