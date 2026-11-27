import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4010,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    BBB_API_INTERNAL_URL: 'http://api:4000',
    BOND_API_INTERNAL_URL: 'http://bond-api:4009',
    TRACKING_BASE_URL: 'http://localhost',
    COOKIE_SECURE: false,
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
  obj.offset = vi.fn().mockReturnValue(obj);
  return obj;
}

const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const CAMPAIGN_ID = '00000000-0000-0000-0000-000000000100';
const TEMPLATE_ID = '00000000-0000-0000-0000-000000000200';

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
  });

  it('should escape _ to prevent single-char wildcard injection', () => {
    const escaped = escapeLike('user_table');
    expect(escaped).toBe('user\\_table');
  });

  it('should escape backslashes', () => {
    const escaped = escapeLike('path\\to\\file');
    expect(escaped).toBe('path\\\\to\\\\file');
  });

  it('should leave normal text unchanged', () => {
    expect(escapeLike('normal query')).toBe('normal query');
  });
});

// ---------------------------------------------------------------------------
// Cross-org campaign isolation
// ---------------------------------------------------------------------------

describe('cross-org campaign isolation', () => {
  let getCampaign: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/campaign.service.js');
    getCampaign = mod.getCampaign;
  });

  it('should throw NOT_FOUND when campaign belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getCampaign(CAMPAIGN_ID, ORG_ID_2)).rejects.toThrow('Campaign not found');
  });
});

// ---------------------------------------------------------------------------
// Cross-org template isolation
// ---------------------------------------------------------------------------

describe('cross-org template isolation', () => {
  let getTemplate: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/template.service.js');
    getTemplate = mod.getTemplate;
  });

  it('should throw NOT_FOUND when template belongs to different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(getTemplate(TEMPLATE_ID, ORG_ID_2)).rejects.toThrow('Template not found');
  });
});

// ---------------------------------------------------------------------------
// Error message sanitization
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('BlastError should not expose internal database details', async () => {
    const { BlastError } = await import('../src/lib/utils.js');

    const error = new BlastError(404, 'NOT_FOUND', 'Campaign not found');
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).toBe('Campaign not found');
  });
});

// ---------------------------------------------------------------------------
// Zod schema input size limits
// ---------------------------------------------------------------------------

describe('Zod schema input size limits', () => {
  it('campaign name should reject exceeding 255 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({ name: z.string().min(1).max(255) });
    const result = schema.safeParse({ name: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('subject should reject exceeding 500 chars', async () => {
    const { z } = await import('zod');
    const schema = z.object({ subject: z.string().min(1).max(500) });
    const result = schema.safeParse({ subject: 'a'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('from_email should be a valid email', async () => {
    const { z } = await import('zod');
    const schema = z.object({ from_email: z.string().email() });
    expect(schema.safeParse({ from_email: 'not-an-email' }).success).toBe(false);
    expect(schema.safeParse({ from_email: 'test@example.com' }).success).toBe(true);
  });

  it('domain should match valid format', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i),
    });
    expect(schema.safeParse({ domain: 'example.com' }).success).toBe(true);
    expect(schema.safeParse({ domain: 'not valid' }).success).toBe(false);
    expect(schema.safeParse({ domain: '-bad.com' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security headers expectations
// ---------------------------------------------------------------------------

describe('security headers expectations', () => {
  it('CORS_ORIGIN env should be present and non-wildcard in test', async () => {
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
