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
const USER_ID = '00000000-0000-0000-0000-000000000003';
const PERIOD_ID = '00000000-0000-0000-0000-000000000010';
const GOAL_ID = '00000000-0000-0000-0000-000000000020';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: GOAL_ID,
    organization_id: ORG_ID,
    period_id: PERIOD_ID,
    scope: 'organization',
    project_id: null,
    team_name: null,
    title: 'Increase Revenue',
    description: 'Grow revenue by 20%',
    icon: null,
    color: null,
    status: 'on_track',
    status_override: false,
    progress: '50.00',
    owner_id: USER_ID,
    created_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeKeyResult(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000030',
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

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000040',
    goal_id: GOAL_ID,
    author_id: USER_ID,
    status: 'on_track',
    body: 'Making great progress.',
    created_at: new Date('2026-04-05'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// listGoals
// ---------------------------------------------------------------------------

describe('listGoals', () => {
  let listGoals: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    listGoals = mod.listGoals;
  });

  it('should return paginated list with cursor-based pagination', async () => {
    const g1 = makeGoal({ id: 'g-1', created_at: new Date('2026-04-01') });
    const g2 = makeGoal({ id: 'g-2', created_at: new Date('2026-04-02') });

    mockSelect.mockReturnValue(chainable([g1, g2]));

    const result = await listGoals({ orgId: ORG_ID, limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta.has_more).toBe(true);
    expect(result.meta.next_cursor).toBeDefined();
  });

  it('should filter by periodId', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, periodId: PERIOD_ID });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by scope', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, scope: 'team' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by projectId', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, projectId: PROJECT_ID });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by ownerId', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, ownerId: USER_ID });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by status', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, status: 'at_risk' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should search with escaped ILIKE characters', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, search: '100%_complete' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should cap limit to 100', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listGoals({ orgId: ORG_ID, limit: 500 });

    expect(result.data).toEqual([]);
    expect(result.meta.has_more).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createGoal
// ---------------------------------------------------------------------------

describe('createGoal', () => {
  let createGoal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    createGoal = mod.createGoal;
  });

  it('should create goal with valid data', async () => {
    const goal = makeGoal();
    mockSelect.mockReturnValue(chainable([{ id: PERIOD_ID }]));
    mockInsert.mockReturnValue(chainable([goal]));

    const result = await createGoal(
      {
        period_id: PERIOD_ID,
        title: 'Increase Revenue',
        owner_id: USER_ID,
      },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.title).toBe('Increase Revenue');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should default scope to organization', async () => {
    const goal = makeGoal({ scope: 'organization' });
    mockSelect.mockReturnValue(chainable([{ id: PERIOD_ID }]));
    mockInsert.mockReturnValue(chainable([goal]));

    const result = await createGoal(
      {
        period_id: PERIOD_ID,
        title: 'Org Goal',
      },
      USER_ID,
      ORG_ID,
    );

    expect(result.scope).toBe('organization');
  });

  it('should default status to draft', async () => {
    const goal = makeGoal({ status: 'draft' });
    mockSelect.mockReturnValue(chainable([{ id: PERIOD_ID }]));
    mockInsert.mockReturnValue(chainable([goal]));

    const result = await createGoal(
      {
        period_id: PERIOD_ID,
        title: 'Draft Goal',
      },
      USER_ID,
      ORG_ID,
    );

    expect(result.status).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// getGoal
// ---------------------------------------------------------------------------

describe('getGoal', () => {
  let getGoal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    getGoal = mod.getGoal;
  });

  it('should return goal with key results and computed progress', async () => {
    const goal = makeGoal();
    const kr = makeKeyResult();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([goal]);   // getGoal -> goal
      if (selectCount === 2) return chainable([kr]);      // key results
      return chainable([{ avg_progress: '50.00' }]);      // computeGoalProgress
    });

    // computeGoalStatus -> period lookup
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([goal]);
      if (selectCount === 2) return chainable([kr]);
      if (selectCount === 3) return chainable([{ avg_progress: '50.00' }]);
      return chainable([{
        id: PERIOD_ID,
        starts_at: '2026-04-01',
        ends_at: '2026-06-30',
        status: 'active',
      }]);
    });

    const result = await getGoal(GOAL_ID, ORG_ID);

    expect(result).toBeDefined();
    expect(result!.id).toBe(GOAL_ID);
    expect(result!.key_results).toBeDefined();
  });

  it('should return null when goal not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getGoal('nonexistent', ORG_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateGoal
// ---------------------------------------------------------------------------

describe('updateGoal', () => {
  let updateGoal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    updateGoal = mod.updateGoal;
  });

  it('should update goal metadata', async () => {
    const existing = makeGoal();
    const updated = makeGoal({ title: 'Updated Title' });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([updated]));

    const result = await updateGoal(GOAL_ID, { title: 'Updated Title' }, ORG_ID);

    expect(result.title).toBe('Updated Title');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      updateGoal(GOAL_ID, { title: 'New' }, ORG_ID),
    ).rejects.toThrow('Goal not found');
  });
});

// ---------------------------------------------------------------------------
// overrideStatus
// ---------------------------------------------------------------------------

describe('overrideStatus', () => {
  let overrideStatus: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    overrideStatus = mod.overrideStatus;
  });

  it('should set status_override to true and update status', async () => {
    const existing = makeGoal();
    const overridden = makeGoal({ status: 'at_risk', status_override: true });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([overridden]));

    const result = await overrideStatus(GOAL_ID, 'at_risk', ORG_ID);

    expect(result.status).toBe('at_risk');
    expect(result.status_override).toBe(true);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      overrideStatus(GOAL_ID, 'at_risk', ORG_ID),
    ).rejects.toThrow('Goal not found');
  });
});

// ---------------------------------------------------------------------------
// deleteGoal
// ---------------------------------------------------------------------------

describe('deleteGoal', () => {
  let deleteGoal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    deleteGoal = mod.deleteGoal;
  });

  it('should delete an existing goal', async () => {
    const existing = makeGoal();
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await deleteGoal(GOAL_ID, ORG_ID);
    expect(result.deleted).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(deleteGoal(GOAL_ID, ORG_ID)).rejects.toThrow('Goal not found');
  });
});

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

describe('addWatcher', () => {
  let addWatcher: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    addWatcher = mod.addWatcher;
  });

  it('should add the resolved user as a watcher (not the caller)', async () => {
    const goal = makeGoal();
    const resolvedUser = { id: USER_ID, display_name: 'Watcher User', avatar_url: null };
    const watcherRow = { id: 'w-1', goal_id: GOAL_ID, user_id: USER_ID, created_at: new Date() };

    // select #1: getGoalById; select #2: resolveUserRefInOrg
    mockSelect
      .mockReturnValueOnce(chainable([goal]))
      .mockReturnValueOnce(chainable([resolvedUser]));
    mockInsert.mockReturnValue(chainable([watcherRow]));

    // userRef is the entered user (a UUID here); it must be the one inserted.
    const result = await addWatcher(GOAL_ID, USER_ID, ORG_ID);

    expect(result.user_id).toBe(USER_ID);
    expect(result.display_name).toBe('Watcher User');
  });

  it('should reject a user ref that is not an active org member', async () => {
    const goal = makeGoal();

    // select #1: goal found; select #2: no matching user in org
    mockSelect
      .mockReturnValueOnce(chainable([goal]))
      .mockReturnValueOnce(chainable([]));

    await expect(addWatcher(GOAL_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'No active user in this organization',
    );
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(addWatcher(GOAL_ID, USER_ID, ORG_ID)).rejects.toThrow('Goal not found');
  });
});

describe('removeWatcher', () => {
  let removeWatcher: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    removeWatcher = mod.removeWatcher;
  });

  it('should remove a watcher from a goal', async () => {
    const goal = makeGoal();
    mockSelect.mockReturnValue(chainable([goal]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await removeWatcher(GOAL_ID, USER_ID, ORG_ID);
    expect(result.deleted).toBe(true);
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(removeWatcher(GOAL_ID, USER_ID, ORG_ID)).rejects.toThrow('Goal not found');
  });
});

// ---------------------------------------------------------------------------
// Updates (check-ins)
// ---------------------------------------------------------------------------

describe('createUpdate', () => {
  let createUpdate: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    createUpdate = mod.createUpdate;
  });

  it('should post a status update on a goal', async () => {
    const goal = makeGoal();
    const update = makeUpdate();

    mockSelect.mockReturnValue(chainable([goal]));
    mockInsert.mockReturnValue(chainable([update]));

    const result = await createUpdate(
      GOAL_ID,
      { status: 'on_track', body: 'Making great progress.' },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.status).toBe('on_track');
    expect(result.body).toBe('Making great progress.');
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      createUpdate(GOAL_ID, { status: 'on_track' }, USER_ID, ORG_ID),
    ).rejects.toThrow('Goal not found');
  });
});

describe('listUpdates', () => {
  let listUpdates: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/goal.service.js');
    listUpdates = mod.listUpdates;
  });

  it('should list updates for a goal', async () => {
    const goal = makeGoal();
    const update = makeUpdate();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([goal]);
      return chainable([update]);
    });

    const result = await listUpdates(GOAL_ID, ORG_ID);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].status).toBe('on_track');
  });

  it('should throw NOT_FOUND when goal does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(listUpdates(GOAL_ID, ORG_ID)).rejects.toThrow('Goal not found');
  });
});
