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
const USER_ID = '00000000-0000-0000-0000-000000000003';
const GOAL_ID = '00000000-0000-0000-0000-000000000020';
const KR_ID = '00000000-0000-0000-0000-000000000030';
const LINK_ID = '00000000-0000-0000-0000-000000000035';

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: GOAL_ID,
    organization_id: ORG_ID,
    period_id: '00000000-0000-0000-0000-000000000010',
    title: 'Increase Revenue',
    status: 'on_track',
    status_override: false,
    progress: '50.00',
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeKeyResult(overrides: Record<string, unknown> = {}) {
  return {
    id: KR_ID,
    goal_id: GOAL_ID,
    title: 'MRR $100k',
    description: null,
    metric_type: 'currency',
    target_value: '100000',
    current_value: '50000',
    start_value: '0',
    unit: 'USD',
    direction: 'increase',
    progress_mode: 'manual',
    progress: '50.00',
    linked_query: null,
    owner_id: USER_ID,
    sort_order: 0,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000045',
    key_result_id: KR_ID,
    value: '50000',
    progress: '50.00',
    recorded_at: new Date('2026-04-05'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listKeyResults
// ---------------------------------------------------------------------------

describe('listKeyResults', () => {
  let listKeyResults: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    listKeyResults = mod.listKeyResults;
  });

  it('should return key results for a goal ordered by sort_order', async () => {
    const kr1 = makeKeyResult({ id: 'kr-1', sort_order: 0 });
    const kr2 = makeKeyResult({ id: 'kr-2', sort_order: 1 });

    mockSelect.mockReturnValue(chainable([{ kr: kr1 }, { kr: kr2 }]));

    const result = await listKeyResults(GOAL_ID, ORG_ID);

    expect(result.data).toEqual([kr1, kr2]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should return empty list when goal has no key results', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listKeyResults(GOAL_ID, ORG_ID);

    expect(result.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createKeyResult
// ---------------------------------------------------------------------------

describe('createKeyResult', () => {
  let createKeyResult: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    createKeyResult = mod.createKeyResult;
  });

  it('should create KR with manual progress mode', async () => {
    const goal = makeGoal();
    const kr = makeKeyResult({ current_value: '0', progress: '0.00' });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      return chainable(selectCount === 1 ? [goal] : []);
    });
    mockInsert.mockReturnValue(chainable([kr]));

    const result = await createKeyResult(
      GOAL_ID,
      {
        title: 'MRR $100k',
        metric_type: 'currency',
        target_value: 100000,
        start_value: 0,
        current_value: 0,
        progress_mode: 'manual',
      },
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.title).toBe('MRR $100k');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      createKeyResult(GOAL_ID, { title: 'Test KR' }, ORG_ID),
    ).rejects.toThrow('Goal not found');
  });

  it('should compute initial progress if current_value > start_value', async () => {
    const goal = makeGoal();
    const kr = makeKeyResult({ current_value: '50000', start_value: '0', target_value: '100000' });
    const updatedKr = makeKeyResult({ progress: '50.00' });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      return chainable(selectCount === 1 ? [goal] : []);
    });
    mockInsert.mockReturnValue(chainable([kr]));
    mockUpdate.mockReturnValue(chainable([updatedKr]));

    const result = await createKeyResult(
      GOAL_ID,
      {
        title: 'Revenue KR',
        target_value: 100000,
        current_value: 50000,
        start_value: 0,
      },
      ORG_ID,
    );

    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// setCurrentValue
// ---------------------------------------------------------------------------

describe('setCurrentValue', () => {
  let setCurrentValue: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    setCurrentValue = mod.setCurrentValue;
  });

  it('should set current value and compute progress', async () => {
    const kr = makeKeyResult({
      start_value: '0',
      current_value: '0',
      target_value: '100000',
      direction: 'increase',
      progress_mode: 'manual',
    });
    const updatedKr = makeKeyResult({ current_value: '75000', progress: '75.00' });

    // getKeyResultWithOrgCheck: select with innerJoin
    mockSelect.mockReturnValue(chainable([{ kr, goal_org_id: ORG_ID }]));
    mockUpdate.mockReturnValue(chainable([updatedKr]));
    // snapshot insert
    mockInsert.mockReturnValue(chainable([{}]));

    const result = await setCurrentValue(KR_ID, 75000, ORG_ID);

    expect(result).toBeDefined();
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled(); // snapshot recorded
  });

  it('should throw NOT_FOUND when key result does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(setCurrentValue(KR_ID, 50, ORG_ID)).rejects.toThrow(
      'Key result not found',
    );
  });

  it('should throw NOT_FOUND when org mismatch on key result', async () => {
    const kr = makeKeyResult();
    mockSelect.mockReturnValue(chainable([{ kr, goal_org_id: '00000000-0000-0000-0000-000000000099' }]));

    await expect(setCurrentValue(KR_ID, 50, ORG_ID)).rejects.toThrow(
      'Key result not found',
    );
  });
});

// ---------------------------------------------------------------------------
// deleteKeyResult
// ---------------------------------------------------------------------------

describe('deleteKeyResult', () => {
  let deleteKeyResult: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    deleteKeyResult = mod.deleteKeyResult;
  });

  it('should delete an existing key result', async () => {
    const kr = makeKeyResult();
    mockSelect.mockReturnValue(chainable([{ kr, goal_org_id: ORG_ID }]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await deleteKeyResult(KR_ID, ORG_ID);
    expect(result.deleted).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when key result does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(deleteKeyResult(KR_ID, ORG_ID)).rejects.toThrow('Key result not found');
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('addLink', () => {
  let addLink: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    addLink = mod.addLink;
  });

  it('should add a link to a key result', async () => {
    const kr = makeKeyResult();
    const link = {
      id: LINK_ID,
      key_result_id: KR_ID,
      link_type: 'drives',
      target_type: 'project',
      target_id: '00000000-0000-0000-0000-000000000002',
      metadata: null,
    };

    mockSelect.mockReturnValue(chainable([{ kr, goal_org_id: ORG_ID }]));
    mockExecute.mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000002' }]);
    mockInsert.mockReturnValue(chainable([link]));

    const result = await addLink(
      KR_ID,
      {
        link_type: 'drives',
        target_type: 'project',
        target_id: '00000000-0000-0000-0000-000000000002',
      },
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.link_type).toBe('drives');
    expect(result.target_type).toBe('project');
  });

  it('should throw NOT_FOUND when key result does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      addLink(KR_ID, { link_type: 'drives', target_type: 'project', target_id: 'x' }, ORG_ID),
    ).rejects.toThrow('Key result not found');
  });
});

describe('removeLink', () => {
  let removeLink: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    removeLink = mod.removeLink;
  });

  it('should remove an existing link', async () => {
    const link = {
      link: { id: LINK_ID, key_result_id: KR_ID },
      goal_org_id: ORG_ID,
    };

    mockSelect.mockReturnValue(chainable([link]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await removeLink(LINK_ID, ORG_ID);
    expect(result.deleted).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when link does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(removeLink(LINK_ID, ORG_ID)).rejects.toThrow('Link not found');
  });

  it('should throw NOT_FOUND when link belongs to a different org', async () => {
    const link = {
      link: { id: LINK_ID, key_result_id: KR_ID },
      goal_org_id: '00000000-0000-0000-0000-000000000099',
    };

    mockSelect.mockReturnValue(chainable([link]));

    await expect(removeLink(LINK_ID, ORG_ID)).rejects.toThrow('Link not found');
  });
});

// ---------------------------------------------------------------------------
// History (snapshots)
// ---------------------------------------------------------------------------

describe('getHistory', () => {
  let getHistory: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/key-result.service.js');
    getHistory = mod.getHistory;
  });

  it('should return snapshots for a key result', async () => {
    const kr = makeKeyResult();
    const snap = makeSnapshot();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([{ kr, goal_org_id: ORG_ID }]);
      return chainable([snap]);
    });

    const result = await getHistory(KR_ID, ORG_ID);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].value).toBe('50000');
  });

  it('should throw NOT_FOUND when key result does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getHistory(KR_ID, ORG_ID)).rejects.toThrow('Key result not found');
  });
});
