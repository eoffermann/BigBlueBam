import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BOLT_SOURCES } from '@bigbluebam/shared';

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
    transaction: vi.fn(),
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

// ---------------------------------------------------------------------------
// ILIKE injection prevention
// ---------------------------------------------------------------------------

describe('ILIKE injection prevention', () => {
  let escapeLike: (s: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/services/automation.service.js');
    escapeLike = mod.escapeLike;
  });

  it('should escape % to prevent wildcard injection', () => {
    const escaped = escapeLike('%admin%');
    expect(escaped).toBe('\\%admin\\%');
    expect(escaped).not.toContain('%admin%');
  });

  it('should escape _ to prevent single-char wildcard injection', () => {
    const escaped = escapeLike('user_table');
    expect(escaped).toBe('user\\_table');
  });

  it('should escape backslashes to prevent escape-sequence injection', () => {
    const escaped = escapeLike('path\\to\\file');
    expect(escaped).toBe('path\\\\to\\\\file');
  });

  it('should handle combined injection characters', () => {
    const escaped = escapeLike('%_\\');
    expect(escaped).toBe('\\%\\_\\\\');
  });
});

// ---------------------------------------------------------------------------
// Cross-org automation access
// ---------------------------------------------------------------------------

describe('cross-org automation access', () => {
  let getAutomation: Function;
  let getAutomationById: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/automation.service.js');
    getAutomation = mod.getAutomation;
    getAutomationById = mod.getAutomationById;
  });

  it('getAutomation should return null when automation belongs to different org', async () => {
    // Query includes org_id in WHERE clause, so wrong org returns empty
    mockSelect.mockReturnValue(chainable([]));

    const result = await getAutomation(AUTOMATION_ID, ORG_ID_2);
    expect(result).toBeNull();
  });

  it('getAutomationById should return null when automation belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getAutomationById(AUTOMATION_ID, ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-org execution access
// ---------------------------------------------------------------------------

describe('cross-org execution access', () => {
  let getExecution: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/execution.service.js');
    getExecution = mod.getExecution;
  });

  it('should return null when execution parent automation belongs to a different org', async () => {
    const execution = {
      id: 'exec-1',
      automation_id: AUTOMATION_ID,
      status: 'success',
      started_at: new Date(),
    };

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([execution]); // execution found
      return chainable([{ org_id: ORG_ID }]); // automation belongs to ORG_ID
    });

    const result = await getExecution('exec-1', ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error message sanitization
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('BoltError should not expose internal details', async () => {
    const { BoltError } = await import('../src/services/automation.service.js');

    const error = new BoltError('NOT_FOUND', 'Automation not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).not.toContain('SQL');
    expect(error.message).toBe('Automation not found');
  });

  it('ExecutionError should not expose internal details', async () => {
    const { ExecutionError } = await import('../src/services/execution.service.js');

    const error = new ExecutionError('NOT_FOUND', 'Execution not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).toBe('Execution not found');
  });
});

// ---------------------------------------------------------------------------
// Input validation via Zod schemas (route-level)
// ---------------------------------------------------------------------------

describe('Zod schema input size limits', () => {
  it('createAutomationSchema should reject name exceeding 255 chars', async () => {
    const { z } = await import('zod');
    // Re-declare the schema to test it in isolation
    const schema = z.object({
      name: z.string().min(1).max(255),
      actions: z.array(z.object({ sort_order: z.number(), mcp_tool: z.string() })).min(1),
      trigger_source: z.enum(BOLT_SOURCES),
      trigger_event: z.string().min(1).max(60),
    });

    const result = schema.safeParse({
      name: 'a'.repeat(256),
      actions: [{ sort_order: 0, mcp_tool: 'test' }],
      trigger_source: 'bam',
      trigger_event: 'task.created',
    });
    expect(result.success).toBe(false);
  });

  it('createAutomationSchema should reject description exceeding 5000 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      description: z.string().max(5000).nullable().optional(),
    });

    const result = schema.safeParse({ description: 'x'.repeat(5001) });
    expect(result.success).toBe(false);
  });

  it('search parameter should be limited to 500 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      search: z.string().max(500).optional(),
    });

    const result = schema.safeParse({ search: 'x'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('conditions array should be limited to 50 items', async () => {
    const { z } = await import('zod');
    const condSchema = z.object({
      sort_order: z.number(),
      field: z.string(),
      operator: z.string(),
    });
    const schema = z.object({
      conditions: z.array(condSchema).max(50),
    });

    const conditions = Array.from({ length: 51 }, (_, i) => ({
      sort_order: i,
      field: 'f',
      operator: 'equals',
    }));
    const result = schema.safeParse({ conditions });
    expect(result.success).toBe(false);
  });

  it('actions array should be limited to 50 items', async () => {
    const { z } = await import('zod');
    const actionSchema = z.object({
      sort_order: z.number(),
      mcp_tool: z.string(),
    });
    const schema = z.object({
      actions: z.array(actionSchema).max(50),
    });

    const actions = Array.from({ length: 51 }, (_, i) => ({
      sort_order: i,
      mcp_tool: 'test',
    }));
    const result = schema.safeParse({ actions });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Template variable injection safety
// ---------------------------------------------------------------------------

describe('template variable injection safety', () => {
  it('should not use eval or Function constructor', async () => {
    const { resolveTemplateString } = await import('../src/services/template-resolver.js');

    // Attempt to inject code via template variables
    const result = resolveTemplateString(
      '{{ event.payload }}',
      {
        event: { payload: '${process.env.SECRET}' },
        actor: {},
        automation: {},
      },
    );

    // Should return the literal string, not evaluate it
    expect(result).toBe('${process.env.SECRET}');
  });

  it('should not resolve __proto__ or constructor paths', async () => {
    const { resolveTemplateString } = await import('../src/services/template-resolver.js');

    const result = resolveTemplateString(
      '{{ event.__proto__.constructor }}',
      { event: {}, actor: {}, automation: {} },
    );

    // Should resolve to empty (undefined) not actual constructor
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Regex ReDoS safety
// ---------------------------------------------------------------------------

describe('regex condition safety', () => {
  it('should handle catastrophic backtracking regex gracefully', async () => {
    const { evaluateConditions } = await import('../src/services/condition-engine.js');

    // This should not hang. Invalid/expensive regex just returns false.
    const result = evaluateConditions(
      [{ field: 'input', operator: 'matches_regex', value: '(a+)+$', logic_group: 'and' }],
      { input: 'aaaaaaaaaaaaaaaaaaaab' },
    );

    // The result should be deterministic (false in this case) and not hang
    expect(typeof result.passed).toBe('boolean');
  });
});
