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
    PORT: 4006,
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
const AUTOMATION_ID = '00000000-0000-0000-0000-000000000050';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';

function makeAutomation(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTOMATION_ID,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    name: 'Test Automation',
    description: 'A test automation',
    enabled: true,
    trigger_source: 'bam',
    trigger_event: 'task.created',
    trigger_filter: null,
    cron_expression: null,
    cron_timezone: 'UTC',
    max_executions_per_hour: 100,
    cooldown_seconds: 0,
    last_executed_at: null,
    created_by: USER_ID,
    updated_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeCondition(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000060',
    automation_id: AUTOMATION_ID,
    sort_order: 0,
    field: 'task.priority',
    operator: 'equals',
    value: 'high',
    logic_group: 'and',
    ...overrides,
  };
}

function makeAction(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000070',
    automation_id: AUTOMATION_ID,
    sort_order: 0,
    mcp_tool: 'banter_post_message',
    parameters: { channel_name: 'alerts', message: 'Hello' },
    on_error: 'stop',
    retry_count: 0,
    retry_delay_ms: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transaction mock helper — simulates db.transaction(async (tx) => { ... })
// The callback receives a fake tx object with the same chainable methods.
// ---------------------------------------------------------------------------

function setupTransaction() {
  const txInsert = vi.fn();
  const txUpdate = vi.fn();
  const txDelete = vi.fn();
  const txSelect = vi.fn();

  const tx = {
    insert: txInsert,
    update: txUpdate,
    delete: txDelete,
    select: txSelect,
  };

  mockTransaction.mockImplementation(async (fn: Function) => fn(tx));

  return { tx, txInsert, txUpdate, txDelete, txSelect };
}

// ---------------------------------------------------------------------------
// escapeLike
// ---------------------------------------------------------------------------

describe('escapeLike', () => {
  let escapeLike: (s: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/services/automation.service.js');
    escapeLike = mod.escapeLike;
  });

  it('should escape % to prevent wildcard injection', () => {
    expect(escapeLike('%admin%')).toBe('\\%admin\\%');
  });

  it('should escape _ to prevent single-char wildcard injection', () => {
    expect(escapeLike('user_table')).toBe('user\\_table');
  });

  it('should escape backslashes', () => {
    expect(escapeLike('path\\file')).toBe('path\\\\file');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeLike('normal query')).toBe('normal query');
  });
});

// ---------------------------------------------------------------------------
// BoltError
// ---------------------------------------------------------------------------

describe('BoltError', () => {
  it('should create error with code, message, and status', async () => {
    const { BoltError } = await import('../src/services/automation.service.js');
    const error = new BoltError('NOT_FOUND', 'Automation not found', 404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Automation not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('BoltError');
  });

  it('should default to 400 status code', async () => {
    const { BoltError } = await import('../src/services/automation.service.js');
    const error = new BoltError('VALIDATION', 'Bad data');
    expect(error.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// listAutomations
// ---------------------------------------------------------------------------

describe('listAutomations', () => {
  let listAutomations: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    listAutomations = mod.listAutomations;
  });

  it('should return paginated list with cursor-based pagination', async () => {
    const auto1 = makeAutomation({ id: 'auto-1', created_at: new Date('2026-04-01') });
    const auto2 = makeAutomation({ id: 'auto-2', created_at: new Date('2026-04-02') });

    mockSelect.mockReturnValue(chainable([auto1, auto2]));

    const result = await listAutomations({ orgId: ORG_ID, limit: 1 });

    expect(result.data).toHaveLength(1);
    expect(result.meta.has_more).toBe(true);
    expect(result.meta.next_cursor).toBeDefined();
  });

  it('should filter by trigger_source', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listAutomations({ orgId: ORG_ID, triggerSource: 'bam' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should filter by enabled state', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listAutomations({ orgId: ORG_ID, enabled: true });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should search with escaped ILIKE', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listAutomations({ orgId: ORG_ID, search: '100%_complete' });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should cap limit to 100', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await listAutomations({ orgId: ORG_ID, limit: 500 });

    expect(result.data).toEqual([]);
    expect(result.meta.has_more).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAutomation
// ---------------------------------------------------------------------------

describe('getAutomation', () => {
  let getAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    getAutomation = mod.getAutomation;
  });

  it('should return automation with joined conditions and actions', async () => {
    const auto = makeAutomation();
    const cond = makeCondition();
    const action = makeAction();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([auto]);
      if (selectCount === 2) return chainable([cond]);
      return chainable([action]);
    });

    const result = await getAutomation(AUTOMATION_ID, ORG_ID);

    expect(result).toBeDefined();
    expect(result.id).toBe(AUTOMATION_ID);
    expect(result.conditions).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
  });

  it('should return null when automation not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getAutomation('nonexistent', ORG_ID);
    expect(result).toBeNull();
  });

  it('should return null for cross-org access (org_id mismatch in query)', async () => {
    // Query includes org_id in WHERE clause, so mismatched org returns empty
    mockSelect.mockReturnValue(chainable([]));

    const result = await getAutomation(AUTOMATION_ID, ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAutomation
// ---------------------------------------------------------------------------

describe('createAutomation', () => {
  let createAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    createAutomation = mod.createAutomation;
  });

  it('should create automation with trigger, conditions, and actions', async () => {
    const auto = makeAutomation();
    const cond = makeCondition();
    const action = makeAction();

    const { txInsert } = setupTransaction();

    let insertCount = 0;
    txInsert.mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) return chainable([auto]);
      if (insertCount === 2) return chainable([cond]);
      return chainable([action]);
    });

    const result = await createAutomation(
      {
        name: 'Test Automation',
        trigger_source: 'bam',
        trigger_event: 'task.created',
        conditions: [
          { sort_order: 0, field: 'task.priority', operator: 'equals', value: 'high' },
        ],
        actions: [
          { sort_order: 0, mcp_tool: 'banter_post_message', parameters: { channel_name: 'alerts' } },
        ],
      },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.name).toBe('Test Automation');
    expect(result.conditions).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
    expect(txInsert).toHaveBeenCalledTimes(3);
  });

  it('should create automation without conditions', async () => {
    const auto = makeAutomation();
    const action = makeAction();

    const { txInsert } = setupTransaction();

    let insertCount = 0;
    txInsert.mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) return chainable([auto]);
      return chainable([action]);
    });

    const result = await createAutomation(
      {
        name: 'No Conditions',
        trigger_source: 'bam',
        trigger_event: 'task.created',
        actions: [{ sort_order: 0, mcp_tool: 'banter_post_message' }],
      },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.conditions).toEqual([]);
    // Only 2 inserts: automation + actions (no conditions)
    expect(txInsert).toHaveBeenCalledTimes(2);
  });

  it('should create schedule entry for schedule triggers', async () => {
    const auto = makeAutomation({ trigger_source: 'schedule', cron_expression: '0 9 * * *' });
    const action = makeAction();

    const { txInsert } = setupTransaction();

    let insertCount = 0;
    txInsert.mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) return chainable([auto]);
      if (insertCount === 2) return chainable([action]);
      return chainable([]); // schedule insert
    });

    await createAutomation(
      {
        name: 'Cron Job',
        trigger_source: 'schedule',
        trigger_event: 'cron.fired',
        cron_expression: '0 9 * * *',
        actions: [{ sort_order: 0, mcp_tool: 'banter_post_message' }],
      },
      USER_ID,
      ORG_ID,
    );

    // automation + actions + schedule = 3
    expect(txInsert).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// updateAutomation
// ---------------------------------------------------------------------------

describe('updateAutomation', () => {
  let updateAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    updateAutomation = mod.updateAutomation;
  });

  it('should replace conditions and actions when provided', async () => {
    const existing = makeAutomation();
    const updated = makeAutomation({ name: 'Updated Name' });
    const newCond = makeCondition({ field: 'task.status' });
    const newAction = makeAction({ mcp_tool: 'create_task' });

    mockSelect.mockReturnValue(chainable([existing]));

    const { txUpdate, txDelete, txInsert, txSelect } = setupTransaction();
    txUpdate.mockReturnValue(chainable([updated]));
    txDelete.mockReturnValue(chainable([]));

    let insertCount = 0;
    txInsert.mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) return chainable([newCond]);
      return chainable([newAction]);
    });

    txSelect.mockReturnValue(chainable([]));

    const result = await updateAutomation(
      AUTOMATION_ID,
      {
        name: 'Updated Name',
        conditions: [{ sort_order: 0, field: 'task.status', operator: 'equals', value: 'done' }],
        actions: [{ sort_order: 0, mcp_tool: 'create_task' }],
      },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(txDelete).toHaveBeenCalled(); // old conditions/actions deleted
    expect(txInsert).toHaveBeenCalled(); // new ones inserted
  });

  it('should throw NOT_FOUND when automation does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      updateAutomation(AUTOMATION_ID, { name: 'New' }, USER_ID, ORG_ID),
    ).rejects.toThrow('Automation not found');
  });
});

// ---------------------------------------------------------------------------
// patchAutomation
// ---------------------------------------------------------------------------

describe('patchAutomation', () => {
  let patchAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    patchAutomation = mod.patchAutomation;
  });

  it('should partially update name and description', async () => {
    const existing = makeAutomation();
    const patched = makeAutomation({ name: 'New Name', description: 'New desc' });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([patched]));

    const result = await patchAutomation(
      AUTOMATION_ID,
      { name: 'New Name', description: 'New desc' },
      USER_ID,
      ORG_ID,
    );

    expect(result.name).toBe('New Name');
    expect(result.description).toBe('New desc');
  });

  it('should throw NOT_FOUND when automation does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      patchAutomation(AUTOMATION_ID, { name: 'X' }, USER_ID, ORG_ID),
    ).rejects.toThrow('Automation not found');
  });
});

// ---------------------------------------------------------------------------
// enableAutomation / disableAutomation
// ---------------------------------------------------------------------------

describe('enableAutomation', () => {
  let enableAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    enableAutomation = mod.enableAutomation;
  });

  it('should enable a disabled automation', async () => {
    const existing = makeAutomation({ enabled: false });
    const enabled = makeAutomation({ enabled: true });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([enabled]));

    const result = await enableAutomation(AUTOMATION_ID, USER_ID, ORG_ID);
    expect(result.enabled).toBe(true);
  });

  it('should throw when already enabled', async () => {
    const existing = makeAutomation({ enabled: true });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(enableAutomation(AUTOMATION_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Automation is already enabled',
    );
  });
});

describe('disableAutomation', () => {
  let disableAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    disableAutomation = mod.disableAutomation;
  });

  it('should disable an enabled automation', async () => {
    const existing = makeAutomation({ enabled: true });
    const disabled = makeAutomation({ enabled: false });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([disabled]));

    const result = await disableAutomation(AUTOMATION_ID, USER_ID, ORG_ID);
    expect(result.enabled).toBe(false);
  });

  it('should throw when already disabled', async () => {
    const existing = makeAutomation({ enabled: false });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(disableAutomation(AUTOMATION_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Automation is already disabled',
    );
  });
});

// ---------------------------------------------------------------------------
// duplicateAutomation
// ---------------------------------------------------------------------------

describe('duplicateAutomation', () => {
  let duplicateAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    duplicateAutomation = mod.duplicateAutomation;
  });

  it('should create a copy with (copy) suffix and disabled state', async () => {
    const existing = makeAutomation();
    const cond = makeCondition();
    const action = makeAction();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([existing]); // getAutomation -> automation
      if (selectCount === 2) return chainable([cond]);       // getAutomation -> conditions
      return chainable([action]);                             // getAutomation -> actions
    });

    const copy = makeAutomation({
      id: '00000000-0000-0000-0000-000000000051',
      name: 'Test Automation (copy)',
      enabled: false,
    });

    const { txInsert } = setupTransaction();
    let insertCount = 0;
    txInsert.mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) return chainable([copy]);
      if (insertCount === 2) return chainable([cond]);
      return chainable([action]);
    });

    const result = await duplicateAutomation(AUTOMATION_ID, USER_ID, ORG_ID);
    expect(result.name).toBe('Test Automation (copy)');
    expect(result.enabled).toBe(false);
  });

  it('should throw NOT_FOUND when source does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(duplicateAutomation(AUTOMATION_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Automation not found',
    );
  });
});

// ---------------------------------------------------------------------------
// deleteAutomation
// ---------------------------------------------------------------------------

describe('deleteAutomation', () => {
  let deleteAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    deleteAutomation = mod.deleteAutomation;
  });

  it('should delete an existing automation', async () => {
    const existing = makeAutomation();
    mockSelect.mockReturnValue(chainable([existing]));
    mockDelete.mockReturnValue(chainable([]));

    const result = await deleteAutomation(AUTOMATION_ID, ORG_ID);
    expect(result.deleted).toBe(true);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when automation does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(deleteAutomation(AUTOMATION_ID, ORG_ID)).rejects.toThrow(
      'Automation not found',
    );
  });
});

// ---------------------------------------------------------------------------
// testAutomation
// ---------------------------------------------------------------------------

describe('testAutomation', () => {
  let testAutomation: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    testAutomation = mod.testAutomation;
  });

  it('should pass when simulated event matches conditions', async () => {
    const auto = makeAutomation();
    const cond = makeCondition({ field: 'task.priority', operator: 'equals', value: 'high' });
    const action = makeAction();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([auto]);
      if (selectCount === 2) return chainable([cond]);
      return chainable([action]);
    });

    const result = await testAutomation(
      AUTOMATION_ID,
      { task: { priority: 'high' } },
      ORG_ID,
    );

    expect(result.passed).toBe(true);
    expect(result.log).toHaveLength(1);
    expect(result.log[0].result).toBe(true);
  });

  it('should fail when simulated event does not match conditions', async () => {
    const auto = makeAutomation();
    const cond = makeCondition({ field: 'task.priority', operator: 'equals', value: 'high' });
    const action = makeAction();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([auto]);
      if (selectCount === 2) return chainable([cond]);
      return chainable([action]);
    });

    const result = await testAutomation(
      AUTOMATION_ID,
      { task: { priority: 'low' } },
      ORG_ID,
    );

    expect(result.passed).toBe(false);
    expect(result.log).toHaveLength(1);
    expect(result.log[0].result).toBe(false);
  });

  it('should pass with no conditions (all events trigger)', async () => {
    const auto = makeAutomation();
    const action = makeAction();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([auto]);
      if (selectCount === 2) return chainable([]); // no conditions
      return chainable([action]);
    });

    const result = await testAutomation(AUTOMATION_ID, { foo: 'bar' }, ORG_ID);

    expect(result.passed).toBe(true);
    expect(result.log).toHaveLength(0);
  });

  it('should throw NOT_FOUND for nonexistent automation', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      testAutomation('nonexistent', {}, ORG_ID),
    ).rejects.toThrow('Automation not found');
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  let getStats: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    getStats = mod.getStats;
  });

  it('should return correct counts', async () => {
    mockExecute.mockResolvedValue([
      {
        total: 10, enabled: 7, disabled: 3,
        source_bam: 4, source_banter: 2, source_beacon: 1,
        source_brief: 1, source_helpdesk: 1, source_schedule: 1,
      },
    ]);

    const result = await getStats(ORG_ID);
    expect(result.total).toBe(10);
    expect(result.enabled).toBe(7);
    expect(result.disabled).toBe(3);
    expect(result.by_source.bam).toBe(4);
    expect(result.by_source.banter).toBe(2);
  });

  it('should return zero counts when no automations exist', async () => {
    mockExecute.mockResolvedValue([]);

    const result = await getStats(ORG_ID);
    expect(result.total).toBe(0);
    expect(result.enabled).toBe(0);
  });
});
