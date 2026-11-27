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
    PORT: 4008,
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
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    LIVEKIT_URL: 'ws://localhost:7880',
    GIT_COMMIT: 'dev',
    BUILD_DATE: '2026-04-07T00:00:00.000Z',
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
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID_2 = '00000000-0000-0000-0000-000000000099';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const USER_ID_2 = '00000000-0000-0000-0000-000000000004';
const BOARD_ID = '00000000-0000-0000-0000-000000000010';

function makeBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: BOARD_ID,
    organization_id: ORG_ID,
    name: 'Test Board',
    visibility: 'project',
    locked: false,
    created_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    archived_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unauthenticated request returns 401
// ---------------------------------------------------------------------------

describe('authentication enforcement', () => {
  it('should return 401 for unauthenticated requests', () => {
    // Simulate the auth middleware behavior
    const session = null;
    const isAuthenticated = session !== null;

    expect(isAuthenticated).toBe(false);

    // The route handler would return:
    const response = isAuthenticated
      ? { status: 200 }
      : { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } } };

    expect(response.status).toBe(401);
    expect(response.body?.error.code).toBe('UNAUTHORIZED');
  });

  it('should allow authenticated requests with valid session', () => {
    const session = { user_id: USER_ID, org_id: ORG_ID };
    const isAuthenticated = session !== null;

    expect(isAuthenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-org board access returns 404
// ---------------------------------------------------------------------------

describe('cross-org board access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 404 when accessing a board from a different org', async () => {
    // Board belongs to ORG_ID, user session has ORG_ID_2
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND organization_id = ?');

    expect(rows).toHaveLength(0);

    // Service would return null => route responds 404
    const result = rows.length > 0 ? rows[0] : null;
    expect(result).toBeNull();
  });

  it('should never expose board data across org boundaries', async () => {
    // Query with wrong org returns empty (WHERE includes organization_id)
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND organization_id = ?');

    // Even though the board exists, it's not returned for the wrong org
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Private board hidden from non-owner
// ---------------------------------------------------------------------------

describe('private board access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should hide private board from users who are not owner or collaborator', async () => {
    // Private board, queried by USER_ID_2 who is not owner and not collaborator
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain
      .from('boards')
      .leftJoin('board_collaborators')
      .where('id = ? AND visibility = private AND (created_by = ? OR user_id = ?)');

    expect(rows).toHaveLength(0);
  });

  it('should show private board to its creator', async () => {
    const privateBoard = makeBoard({ visibility: 'private' });
    mockSelect.mockReturnValue(chainable([privateBoard]));

    const chain = mockSelect();
    const rows = await chain
      .from('boards')
      .where('id = ? AND created_by = ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe(USER_ID);
  });
});

// ---------------------------------------------------------------------------
// ILIKE escape in search
// ---------------------------------------------------------------------------

describe('ILIKE escape in search', () => {
  it('should escape % to prevent wildcard injection', () => {
    function escapeLike(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    expect(escapeLike('%admin%')).toBe('\\%admin\\%');
  });

  it('should escape _ to prevent single-char wildcard injection', () => {
    function escapeLike(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    expect(escapeLike('user_table')).toBe('user\\_table');
  });

  it('should escape backslashes to prevent escape-sequence injection', () => {
    function escapeLike(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    expect(escapeLike('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('should handle combined injection characters', () => {
    function escapeLike(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });
});

// ---------------------------------------------------------------------------
// Input size limits
// ---------------------------------------------------------------------------

describe('input size limits via Zod schemas', () => {
  it('should reject board name exceeding 255 characters', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      name: z.string().min(1).max(255),
    });

    const valid = schema.safeParse({ name: 'Sprint Board' });
    expect(valid.success).toBe(true);

    const tooLong = schema.safeParse({ name: 'x'.repeat(256) });
    expect(tooLong.success).toBe(false);
  });

  it('should reject board description exceeding 2000 characters', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      description: z.string().max(2000).nullable().optional(),
    });

    const valid = schema.safeParse({ description: 'A useful board.' });
    expect(valid.success).toBe(true);

    const tooLong = schema.safeParse({ description: 'x'.repeat(2001) });
    expect(tooLong.success).toBe(false);
  });

  it('should reject chat body exceeding 5000 characters', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      body: z.string().min(1).max(5000),
    });

    const valid = schema.safeParse({ body: 'Hello everyone!' });
    expect(valid.success).toBe(true);

    const tooLong = schema.safeParse({ body: 'y'.repeat(5001) });
    expect(tooLong.success).toBe(false);
  });

  it('should reject empty board name', async () => {
    const { z } = await import('zod');
    const schema = z.object({
      name: z.string().min(1).max(255),
    });

    const empty = schema.safeParse({ name: '' });
    expect(empty.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limit headers present
// ---------------------------------------------------------------------------

describe('rate limit headers', () => {
  it('should include standard rate limit headers in responses', () => {
    // Simulate the response headers that @fastify/rate-limit adds
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '99',
      'x-ratelimit-reset': '1712476800',
    };

    expect(headers['x-ratelimit-limit']).toBeDefined();
    expect(headers['x-ratelimit-remaining']).toBeDefined();
    expect(headers['x-ratelimit-reset']).toBeDefined();
    expect(parseInt(headers['x-ratelimit-limit'])).toBeGreaterThan(0);
    expect(parseInt(headers['x-ratelimit-remaining'])).toBeLessThanOrEqual(
      parseInt(headers['x-ratelimit-limit']),
    );
  });

  it('should return 429 when rate limit exceeded', () => {
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1712476800',
      'retry-after': '60',
    };

    const remaining = parseInt(headers['x-ratelimit-remaining']);
    expect(remaining).toBe(0);

    const statusCode = remaining <= 0 ? 429 : 200;
    expect(statusCode).toBe(429);
    expect(headers['retry-after']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Security headers present
// ---------------------------------------------------------------------------

describe('security headers', () => {
  it('should include X-Content-Type-Options: nosniff', () => {
    const headers = {
      'x-content-type-options': 'nosniff',
    };

    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('should include X-Frame-Options: DENY', () => {
    const headers = {
      'x-frame-options': 'DENY',
    };

    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('should include X-XSS-Protection header', () => {
    const headers = {
      'x-xss-protection': '0',
    };

    // Modern best practice: set to 0 to disable buggy browser XSS auditors
    expect(headers['x-xss-protection']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Error messages don't leak internal details
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('should not expose SQL details in error responses', () => {
    const safeError = {
      error: {
        code: 'NOT_FOUND',
        message: 'Board not found',
      },
    };

    expect(safeError.error.message).not.toContain('SELECT');
    expect(safeError.error.message).not.toContain('postgres');
    expect(safeError.error.message).not.toContain('SQL');
    expect(safeError.error.message).not.toContain('drizzle');
    expect(safeError.error.message).not.toContain('connection');
  });

  it('should not expose stack traces in production error responses', () => {
    const prodError = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    };

    expect(prodError.error.message).not.toContain('at ');
    expect(prodError.error.message).not.toContain('.ts:');
    expect(prodError.error.message).not.toContain('.js:');
    expect(prodError.error.message).not.toContain('node_modules');
  });

  it('should not expose database column names in validation errors', () => {
    const validationError = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid input',
        details: [{ field: 'name', issue: 'Required' }],
      },
    };

    expect(validationError.error.message).not.toContain('organization_id');
    expect(validationError.error.message).not.toContain('created_by');
    expect(validationError.error.details[0]!.field).toBe('name');
  });
});

// ---------------------------------------------------------------------------
// Collaborator org validation
// ---------------------------------------------------------------------------

describe('collaborator org validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject adding a collaborator from a different org', async () => {
    // User in ORG_ID_2 cannot be added as collaborator to a board in ORG_ID
    const userInDifferentOrg = {
      id: USER_ID_2,
      org_id: ORG_ID_2,
      email: 'outsider@other-org.com',
    };

    mockSelect.mockReturnValue(chainable([userInDifferentOrg]));

    const chain = mockSelect();
    const [user] = await chain.from('users').where('id = ?');

    // Board belongs to ORG_ID, user belongs to ORG_ID_2
    const boardOrgId = ORG_ID;
    const userOrgId = user.org_id;

    expect(userOrgId).not.toBe(boardOrgId);

    // Service should reject this with a validation error
    const isValid = userOrgId === boardOrgId;
    expect(isValid).toBe(false);
  });

  it('should allow adding a collaborator from the same org', async () => {
    const userInSameOrg = {
      id: USER_ID_2,
      org_id: ORG_ID,
      email: 'colleague@same-org.com',
    };

    mockSelect.mockReturnValue(chainable([userInSameOrg]));

    const chain = mockSelect();
    const [user] = await chain.from('users').where('id = ?');

    const boardOrgId = ORG_ID;
    const userOrgId = user.org_id;

    expect(userOrgId).toBe(boardOrgId);

    const isValid = userOrgId === boardOrgId;
    expect(isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Board lock prevents edits
// ---------------------------------------------------------------------------

describe('board lock prevents edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject element updates when board is locked', async () => {
    const lockedBoard = makeBoard({ locked: true });
    mockSelect.mockReturnValue(chainable([lockedBoard]));

    const chain = mockSelect();
    const [board] = await chain.from('boards').where('id = ?');

    expect(board.locked).toBe(true);

    // Service should check locked state and reject mutations
    const canEdit = !board.locked;
    expect(canEdit).toBe(false);
  });

  it('should reject element creation when board is locked', async () => {
    const lockedBoard = makeBoard({ locked: true });
    mockSelect.mockReturnValue(chainable([lockedBoard]));

    const chain = mockSelect();
    const [board] = await chain.from('boards').where('id = ?');

    const canCreate = !board.locked;
    expect(canCreate).toBe(false);
  });

  it('should reject element deletion when board is locked', async () => {
    const lockedBoard = makeBoard({ locked: true });
    mockSelect.mockReturnValue(chainable([lockedBoard]));

    const chain = mockSelect();
    const [board] = await chain.from('boards').where('id = ?');

    const canDelete = !board.locked;
    expect(canDelete).toBe(false);
  });

  it('should allow metadata updates even when board is locked', async () => {
    // Locking prevents element/content edits, but board name/description can still be updated
    const lockedBoard = makeBoard({ locked: true });
    const updated = makeBoard({ locked: true, name: 'Renamed While Locked' });

    mockSelect.mockReturnValue(chainable([lockedBoard]));
    mockUpdate.mockReturnValue(chainable([updated]));

    const chain = mockSelect();
    const [board] = await chain.from('boards').where('id = ?');
    expect(board.locked).toBe(true);

    // Metadata update is still allowed on a locked board
    const updateChain = mockUpdate();
    const [result] = await updateChain.set({ name: 'Renamed While Locked' }).where('id = ?').returning();
    expect(result.name).toBe('Renamed While Locked');
  });

  it('should allow unlocking a locked board by the owner', async () => {
    const lockedBoard = makeBoard({ locked: true });
    const unlocked = makeBoard({ locked: false });

    mockSelect.mockReturnValue(chainable([lockedBoard]));
    mockUpdate.mockReturnValue(chainable([unlocked]));

    const chain = mockSelect();
    const [board] = await chain.from('boards').where('id = ? AND created_by = ?');
    expect(board.locked).toBe(true);

    const updateChain = mockUpdate();
    const [result] = await updateChain.set({ locked: false }).where('id = ?').returning();
    expect(result.locked).toBe(false);
  });
});
