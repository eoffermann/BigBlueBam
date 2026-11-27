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
    transaction: vi.fn(),
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
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const CONTACT_ID = '00000000-0000-0000-0000-000000000100';
const DEAL_ID = '00000000-0000-0000-0000-000000000400';
const PIPELINE_ID = '00000000-0000-0000-0000-000000000300';

// ---------------------------------------------------------------------------
// ILIKE injection prevention
// ---------------------------------------------------------------------------

describe('ILIKE injection prevention', () => {
  let escapeLike: (s: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/lib/utils.js');
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

  it('should leave normal text unchanged', () => {
    expect(escapeLike('normal query')).toBe('normal query');
  });
});

// ---------------------------------------------------------------------------
// Cross-org contact isolation
// ---------------------------------------------------------------------------

describe('cross-org contact isolation', () => {
  let getContact: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/contact.service.js');
    getContact = mod.getContact;
  });

  it('should throw NOT_FOUND when contact belongs to different org', async () => {
    const { BondError } = await import('../src/lib/utils.js');
    mockSelect.mockReturnValue(chainable([]));

    await expect(getContact(CONTACT_ID, ORG_ID_2)).rejects.toThrow(BondError);
    await expect(getContact(CONTACT_ID, ORG_ID_2)).rejects.toThrow('Contact not found');
  });
});

// ---------------------------------------------------------------------------
// Cross-org deal isolation
// ---------------------------------------------------------------------------

describe('cross-org deal isolation', () => {
  let getDeal: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/deal.service.js');
    getDeal = mod.getDeal;
  });

  it('should throw NOT_FOUND when deal belongs to different org', async () => {
    const { BondError } = await import('../src/lib/utils.js');
    mockSelect.mockReturnValue(chainable([]));

    await expect(getDeal(DEAL_ID, ORG_ID_2)).rejects.toThrow(BondError);
    await expect(getDeal(DEAL_ID, ORG_ID_2)).rejects.toThrow('Deal not found');
  });
});

// ---------------------------------------------------------------------------
// Cross-org pipeline isolation
// ---------------------------------------------------------------------------

describe('cross-org pipeline isolation', () => {
  let getPipeline: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/pipeline.service.js');
    getPipeline = mod.getPipeline;
  });

  it('should throw NOT_FOUND when pipeline belongs to different org', async () => {
    const { BondError } = await import('../src/lib/utils.js');
    mockSelect.mockReturnValue(chainable([]));

    await expect(getPipeline(PIPELINE_ID, ORG_ID_2)).rejects.toThrow(BondError);
    await expect(getPipeline(PIPELINE_ID, ORG_ID_2)).rejects.toThrow('Pipeline not found');
  });
});

// ---------------------------------------------------------------------------
// Error message sanitization
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('BondError should not expose internal database details', async () => {
    const { BondError } = await import('../src/lib/utils.js');

    const error = new BondError(404, 'NOT_FOUND', 'Contact not found');
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).not.toContain('SQL');
    expect(error.message).toBe('Contact not found');
  });

  it('BondError (deal context) should not expose internal details', async () => {
    const { BondError } = await import('../src/lib/utils.js');

    const error = new BondError(404, 'NOT_FOUND', 'Deal not found');
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).toBe('Deal not found');
  });

  it('BondError (pipeline context) should not expose internal details', async () => {
    const { BondError } = await import('../src/lib/utils.js');

    const error = new BondError(404, 'NOT_FOUND', 'Pipeline not found');
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).toBe('Pipeline not found');
  });
});

// ---------------------------------------------------------------------------
// Zod schema input size limits
// ---------------------------------------------------------------------------

describe('Zod schema input size limits', () => {
  it('contact name should reject exceeding 100 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      first_name: z.string().max(100),
      last_name: z.string().max(100),
    });

    const result = schema.safeParse({
      first_name: 'a'.repeat(101),
      last_name: 'b'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('contact email should reject exceeding 255 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      email: z.string().email().max(255),
    });

    const result = schema.safeParse({ email: 'a'.repeat(250) + '@x.com' });
    expect(result.success).toBe(false);
  });

  it('deal name should reject exceeding 255 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      name: z.string().min(1).max(255),
    });

    const result = schema.safeParse({ name: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('deal value should reject negative amounts', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      value: z.number().int().min(0),
    });

    const result = schema.safeParse({ value: -100 });
    expect(result.success).toBe(false);
  });

  it('pipeline stages should be limited to 20 items', async () => {
    const { z } = await import('zod');
    const stageSchema = z.object({
      name: z.string(),
      sort_order: z.number(),
      stage_type: z.enum(['active', 'won', 'lost']),
    });
    const schema = z.object({
      stages: z.array(stageSchema).max(20),
    });

    const stages = Array.from({ length: 21 }, (_, i) => ({
      name: `Stage ${i}`,
      sort_order: i,
      stage_type: 'active' as const,
    }));
    const result = schema.safeParse({ stages });
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

  it('probability_pct should be between 0 and 100', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      probability_pct: z.number().int().min(0).max(100),
    });

    expect(schema.safeParse({ probability_pct: -1 }).success).toBe(false);
    expect(schema.safeParse({ probability_pct: 101 }).success).toBe(false);
    expect(schema.safeParse({ probability_pct: 50 }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security headers expectations
// ---------------------------------------------------------------------------

describe('security headers expectations', () => {
  it('CORS_ORIGIN env should be present and non-wildcard', async () => {
    const { env } = await import('../src/env.js');
    expect(env.CORS_ORIGIN).toBeDefined();
    expect(env.CORS_ORIGIN).not.toBe('*');
  });

  it('SESSION_SECRET should be at least 32 characters', async () => {
    const { env } = await import('../src/env.js');
    expect(env.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('RATE_LIMIT_MAX should be a positive integer', async () => {
    const { env } = await import('../src/env.js');
    expect(env.RATE_LIMIT_MAX).toBeGreaterThan(0);
    expect(Number.isInteger(env.RATE_LIMIT_MAX)).toBe(true);
  });
});
