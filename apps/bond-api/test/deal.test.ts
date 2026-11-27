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
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
    PUBLIC_URL: 'http://localhost',
  },
}));

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

function chainable(result: unknown[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject?: Function) =>
    Promise.resolve(result).then(resolve as any, reject as any);
  obj.limit = vi.fn().mockReturnValue(obj);
  obj.offset = vi.fn().mockResolvedValue(result);
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
  obj.onConflictDoUpdate = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const PIPELINE_ID = '00000000-0000-0000-0000-000000000300';
const STAGE_ID_1 = '00000000-0000-0000-0000-000000000310';
const STAGE_ID_2 = '00000000-0000-0000-0000-000000000311';
const STAGE_ID_WON = '00000000-0000-0000-0000-000000000319';
const STAGE_ID_LOST = '00000000-0000-0000-0000-000000000320';
const DEAL_ID = '00000000-0000-0000-0000-000000000400';
const COMPANY_ID = '00000000-0000-0000-0000-000000000200';

function makeDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: DEAL_ID,
    organization_id: ORG_ID,
    pipeline_id: PIPELINE_ID,
    stage_id: STAGE_ID_1,
    name: 'Enterprise License Deal',
    description: 'Annual enterprise license',
    value: 50000_00, // cents
    currency: 'USD',
    expected_close_date: '2026-06-30',
    probability_pct: 60,
    weighted_value: 30000_00,
    closed_at: null,
    close_reason: null,
    lost_to_competitor: null,
    owner_id: USER_ID,
    company_id: COMPANY_ID,
    custom_fields: {},
    stage_entered_at: new Date('2026-04-01'),
    last_activity_at: new Date('2026-04-05'),
    created_by: USER_ID,
    created_at: new Date('2026-03-15'),
    updated_at: new Date('2026-04-05'),
    ...overrides,
  };
}

function makeStage(overrides: Record<string, unknown> = {}) {
  return {
    id: STAGE_ID_1,
    pipeline_id: PIPELINE_ID,
    name: 'Qualification',
    sort_order: 0,
    stage_type: 'active',
    probability_pct: 20,
    rotting_days: 14,
    color: '#3B82F6',
    created_at: new Date('2026-01-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listDeals
// ---------------------------------------------------------------------------

describe('listDeals', () => {
  let listDeals: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    listDeals = mod.listDeals;
  });

  it('should return paginated deals with limit/offset pagination', async () => {
    const d1 = makeDeal({ id: 'd-1', created_at: new Date('2026-04-01') });
    const d2 = makeDeal({ id: 'd-2', created_at: new Date('2026-04-02') });

    mockSelect.mockReturnValue(chainable([d1, d2]));

    const result = await listDeals({ organization_id: ORG_ID, limit: 1 });

    expect(result.data).toBeDefined();
    expect(result.limit).toBe(1);
    expect(result.offset).toBe(0);
  });

  it('should filter by pipeline_id', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listDeals({
      organization_id: ORG_ID,
      pipeline_id: PIPELINE_ID,
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by stage_id', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listDeals({
      organization_id: ORG_ID,
      stage_id: STAGE_ID_1,
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by owner_id', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listDeals({
      organization_id: ORG_ID,
      owner_id: USER_ID,
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should cap limit to 100', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listDeals({ organization_id: ORG_ID, limit: 500 });

    expect(result.data).toEqual([]);
    expect(result.limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// getDeal
// ---------------------------------------------------------------------------

describe('getDeal', () => {
  let getDeal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    getDeal = mod.getDeal;
  });

  it('should return deal with stage, contacts, and activities', async () => {
    const deal = makeDeal({ company_id: null });
    const stage = makeStage();

    // Sequence: 1) deal, 2) contacts, 3) stage_history, 4) activities, 5) stage
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([deal]);
      if (selectCount === 2) return chainable([{ contact_id: 'c-1', first_name: 'Ada' }]);
      if (selectCount === 3) return chainable([]); // stage_history
      if (selectCount === 4) return chainable([{ id: 'act-1', activity_type: 'note' }]);
      return chainable([stage]);
    });

    const result = await getDeal(DEAL_ID, ORG_ID);

    expect(result).toBeDefined();
    expect(result.id).toBe(DEAL_ID);
    expect(result.stage).toBeDefined();
    expect(result.contacts).toHaveLength(1);
    expect(result.recent_activities).toHaveLength(1);
  });

  it('should throw NOT_FOUND when deal not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getDeal('nonexistent', ORG_ID)).rejects.toThrow('Deal not found');
  });

  it('should throw NOT_FOUND for cross-org access', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getDeal(DEAL_ID, ORG_ID_2)).rejects.toThrow('Deal not found');
  });
});

// ---------------------------------------------------------------------------
// createDeal
// ---------------------------------------------------------------------------

describe('createDeal', () => {
  let createDeal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    createDeal = mod.createDeal;
  });

  it('should create a deal and record initial stage history', async () => {
    const deal = makeDeal();
    const pipeline = { id: PIPELINE_ID, currency: 'USD' };

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([pipeline]); // pipeline lookup
      return chainable([makeStage()]); // stage lookup
    });

    mockInsert.mockReturnValue(chainable([deal]));

    const result = await createDeal(
      {
        name: 'Enterprise License Deal',
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID_1,
        value: 50000_00,
      },
      ORG_ID,
      USER_ID,
    );

    expect(result).toBeDefined();
    expect(result.name).toBe('Enterprise License Deal');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should reject when stage does not belong to pipeline', async () => {
    const pipeline = { id: PIPELINE_ID, currency: 'USD' };

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([pipeline]); // pipeline lookup
      return chainable([]); // stage not found in pipeline
    });

    await expect(
      createDeal(
        { name: 'Bad Deal', pipeline_id: PIPELINE_ID, stage_id: 'wrong-stage' },
        ORG_ID,
        USER_ID,
      ),
    ).rejects.toThrow('Stage not found in this pipeline');
  });
});

// ---------------------------------------------------------------------------
// moveDealStage (stage transition)
// ---------------------------------------------------------------------------

describe('moveDealStage', () => {
  let moveDealStage: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    moveDealStage = mod.moveDealStage;
  });

  it('should move deal to new stage and log history', async () => {
    const existing = makeDeal({ stage_id: STAGE_ID_1 });
    const moved = makeDeal({ stage_id: STAGE_ID_2, stage_entered_at: new Date() });

    // Sequence: 1) deal lookup, 2) new stage lookup
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([existing]);
      return chainable([makeStage({ id: STAGE_ID_2, sort_order: 1 })]);
    });

    mockInsert.mockReturnValue(chainable([])); // stage_history + activity
    mockUpdate.mockReturnValue(chainable([moved]));

    const result = await moveDealStage(DEAL_ID, ORG_ID, STAGE_ID_2, USER_ID);

    expect(result.stage_id).toBe(STAGE_ID_2);
    expect(mockInsert).toHaveBeenCalled(); // stage history recorded
  });

  it('should return deal unchanged when new stage equals current stage', async () => {
    const existing = makeDeal({ stage_id: STAGE_ID_1 });
    mockSelect.mockReturnValue(chainable([existing]));

    const result = await moveDealStage(DEAL_ID, ORG_ID, STAGE_ID_1, USER_ID);
    expect(result.stage_id).toBe(STAGE_ID_1);
  });

  it('should throw NOT_FOUND for nonexistent deal', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      moveDealStage('nonexistent', ORG_ID, STAGE_ID_2, USER_ID),
    ).rejects.toThrow('Deal not found');
  });
});

// ---------------------------------------------------------------------------
// closeDealWon / closeDealLost
// ---------------------------------------------------------------------------

describe('closeDealWon', () => {
  let closeDealWon: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    closeDealWon = mod.closeDealWon;
  });

  it('should mark deal as won with closed_at timestamp', async () => {
    const existing = makeDeal({ stage_id: STAGE_ID_1 });
    const won = makeDeal({
      stage_id: STAGE_ID_WON,
      closed_at: new Date(),
      probability_pct: 100,
    });

    // Sequence: 1) deal lookup, 2) won stage lookup
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([existing]);
      return chainable([makeStage({ id: STAGE_ID_WON, stage_type: 'won' })]);
    });

    mockInsert.mockReturnValue(chainable([]));
    mockUpdate.mockReturnValue(chainable([won]));

    const result = await closeDealWon(DEAL_ID, ORG_ID, USER_ID, 'Great fit');

    expect(result.closed_at).toBeDefined();
    expect(result.probability_pct).toBe(100);
  });

  it('should throw when deal is already closed', async () => {
    const closed = makeDeal({ closed_at: new Date() });
    mockSelect.mockReturnValue(chainable([closed]));

    await expect(
      closeDealWon(DEAL_ID, ORG_ID, USER_ID),
    ).rejects.toThrow('Deal is already closed');
  });
});

describe('closeDealLost', () => {
  let closeDealLost: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    closeDealLost = mod.closeDealLost;
  });

  it('should mark deal as lost with reason and competitor', async () => {
    const existing = makeDeal({ stage_id: STAGE_ID_1 });
    const lost = makeDeal({
      stage_id: STAGE_ID_LOST,
      closed_at: new Date(),
      probability_pct: 0,
      close_reason: 'Budget cuts',
      lost_to_competitor: 'CompetitorCo',
    });

    // Sequence: 1) deal lookup, 2) lost stage lookup
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([existing]);
      return chainable([makeStage({ id: STAGE_ID_LOST, stage_type: 'lost' })]);
    });

    mockInsert.mockReturnValue(chainable([]));
    mockUpdate.mockReturnValue(chainable([lost]));

    const result = await closeDealLost(
      DEAL_ID,
      ORG_ID,
      USER_ID,
      'Budget cuts',
      'CompetitorCo',
    );

    expect(result.closed_at).toBeDefined();
    expect(result.probability_pct).toBe(0);
    expect(result.lost_to_competitor).toBe('CompetitorCo');
  });
});

// ---------------------------------------------------------------------------
// detectStaleDeals
// ---------------------------------------------------------------------------

describe('detectStaleDeals', () => {
  let detectStaleDeals: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    detectStaleDeals = mod.detectStaleDeals;
  });

  it('should return deals that have exceeded rotting_days in their stage', async () => {
    const staleDeal = makeDeal({
      stage_entered_at: new Date('2026-03-01'), // over 30 days ago
    });

    mockExecute.mockResolvedValue([
      { ...staleDeal, stage_name: 'Qualification', rotting_days: 14, days_in_stage: 37 },
    ]);

    const result = await detectStaleDeals(ORG_ID);

    expect(result).toHaveLength(1);
    expect(result[0].days_in_stage).toBeGreaterThan(14);
  });

  it('should return empty when no deals are stale', async () => {
    mockExecute.mockResolvedValue([]);

    const result = await detectStaleDeals(ORG_ID);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// updateDeal
// ---------------------------------------------------------------------------

describe('updateDeal', () => {
  let updateDeal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    updateDeal = mod.updateDeal;
  });

  it('should update deal fields', async () => {
    const updated = makeDeal({ name: 'Updated Deal', value: 75000_00 });

    mockUpdate.mockReturnValue(chainable([updated]));

    const result = await updateDeal(
      DEAL_ID,
      ORG_ID,
      { name: 'Updated Deal', value: 75000_00 },
      USER_ID,
    );

    expect(result.name).toBe('Updated Deal');
    expect(result.value).toBe(75000_00);
  });

  it('should throw NOT_FOUND when deal does not exist', async () => {
    mockUpdate.mockReturnValue(chainable([]));

    await expect(
      updateDeal(DEAL_ID, ORG_ID, { name: 'X' }, USER_ID),
    ).rejects.toThrow('Deal not found');
  });
});

// ---------------------------------------------------------------------------
// deleteDeal
// ---------------------------------------------------------------------------

describe('deleteDeal', () => {
  let deleteDeal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    deleteDeal = mod.deleteDeal;
  });

  it('should delete an existing deal', async () => {
    // deleteDeal is a soft-delete via db.update(...).set({ deleted_at }).
    mockUpdate.mockReturnValue(chainable([{ id: DEAL_ID }]));

    const result = await deleteDeal(DEAL_ID, ORG_ID);
    expect(result.id).toBe(DEAL_ID);
  });

  it('should throw NOT_FOUND when deal does not exist', async () => {
    mockUpdate.mockReturnValue(chainable([]));

    await expect(deleteDeal(DEAL_ID, ORG_ID)).rejects.toThrow('Deal not found');
  });
});
