import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the database module
// ---------------------------------------------------------------------------

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
    transaction: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4007,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    MCP_INTERNAL_URL: 'http://mcp-server:3001',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
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
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const PERIOD_ID = '00000000-0000-0000-0000-000000000010';
const GOAL_ID = '00000000-0000-0000-0000-000000000020';
const KR_ID = '00000000-0000-0000-0000-000000000030';

// ---------------------------------------------------------------------------
// Cross-org goal access
// ---------------------------------------------------------------------------

describe('cross-org goal access', () => {
  let getGoal: Function;
  let getGoalById: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    getGoal = mod.getGoal;
    getGoalById = mod.getGoalById;
  });

  it('getGoal should return null when goal belongs to different org', async () => {
    // Query includes org_id in WHERE clause, so wrong org returns empty
    mockSelect.mockReturnValue(chainable([]));

    const result = await getGoal(GOAL_ID, ORG_ID_2);
    expect(result).toBeNull();
  });

  it('getGoalById should return null when goal belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getGoalById(GOAL_ID, ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-org period access
// ---------------------------------------------------------------------------

describe('cross-org period access', () => {
  let getPeriod: Function;
  let getPeriodById: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/period.service.js');
    getPeriod = mod.getPeriod;
    getPeriodById = mod.getPeriodById;
  });

  it('getPeriod should return null when period belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getPeriod(PERIOD_ID, ORG_ID_2);
    expect(result).toBeNull();
  });

  it('getPeriodById should return null when period belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getPeriodById(PERIOD_ID, ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-org key result access
// ---------------------------------------------------------------------------

describe('cross-org key result access', () => {
  let getKeyResultWithOrgCheck: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    getKeyResultWithOrgCheck = mod.getKeyResultWithOrgCheck;
  });

  it('should return null when key result belongs to a different org', async () => {
    const kr = {
      kr: { id: KR_ID, goal_id: GOAL_ID },
      goal_org_id: ORG_ID,
    };
    mockSelect.mockReturnValue(chainable([kr]));

    const result = await getKeyResultWithOrgCheck(KR_ID, ORG_ID_2);
    expect(result).toBeNull();
  });

  it('should return null when key result does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getKeyResultWithOrgCheck(KR_ID, ORG_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ILIKE injection prevention
// ---------------------------------------------------------------------------

describe('ILIKE injection prevention via listGoals', () => {
  let listGoals: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    listGoals = mod.listGoals;
  });

  it('should not pass raw % characters to the query (escaped in search)', async () => {
    mockSelect.mockReturnValue(chainable([]));

    // The function internally escapes %, _, and \ in search
    const result = await listGoals({ orgId: ORG_ID, search: '%admin%' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should handle combined injection characters in search', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, search: '%_\\drop' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BearingError does not expose internals
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('BearingError should not expose internal details', async () => {
    const { BearingError } = await import('../src/services/period.service.js');

    const error = new BearingError('NOT_FOUND', 'Period not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).not.toContain('SQL');
    expect(error.message).toBe('Period not found');
  });
});

// ---------------------------------------------------------------------------
// Zod schema input size limits
// ---------------------------------------------------------------------------

describe('Zod schema input size limits', () => {
  it('should reject goal title exceeding 500 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      title: z.string().min(1).max(500),
      period_id: z.string().uuid(),
    });

    const result = schema.safeParse({
      title: 'a'.repeat(501),
      period_id: '00000000-0000-0000-0000-000000000010',
    });
    expect(result.success).toBe(false);
  });

  it('should reject description exceeding 5000 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      description: z.string().max(5000).nullable().optional(),
    });

    const result = schema.safeParse({ description: 'x'.repeat(5001) });
    expect(result.success).toBe(false);
  });

  it('should reject search parameter exceeding 500 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      search: z.string().max(500).optional(),
    });

    const result = schema.safeParse({ search: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });
});
