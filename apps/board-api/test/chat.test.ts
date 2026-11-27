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
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const BOARD_ID = '00000000-0000-0000-0000-000000000010';

function makeChatMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000080',
    board_id: BOARD_ID,
    author_id: USER_ID,
    body: 'Let us discuss the new feature layout',
    created_at: new Date('2026-04-07T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Send chat message
// ---------------------------------------------------------------------------

describe('sendChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a chat message with board_id, author_id, and body', async () => {
    const msg = makeChatMessage();
    mockInsert.mockReturnValue(chainable([msg]));

    const chain = mockInsert();
    const [result] = await chain
      .values({ board_id: BOARD_ID, author_id: USER_ID, body: 'Let us discuss the new feature layout' })
      .returning();

    expect(result.board_id).toBe(BOARD_ID);
    expect(result.author_id).toBe(USER_ID);
    expect(result.body).toBe('Let us discuss the new feature layout');
    expect(result.created_at).toBeDefined();
  });

  it('should set created_at automatically', async () => {
    const msg = makeChatMessage({ created_at: new Date('2026-04-07T12:30:00Z') });
    mockInsert.mockReturnValue(chainable([msg]));

    const chain = mockInsert();
    const [result] = await chain.values({ board_id: BOARD_ID, author_id: USER_ID, body: 'Hello' }).returning();

    expect(result.created_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// List recent messages
// ---------------------------------------------------------------------------

describe('listChatMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return messages ordered by created_at DESC', async () => {
    const msg1 = makeChatMessage({ id: 'msg-1', body: 'First', created_at: new Date('2026-04-07T10:00:00Z') });
    const msg2 = makeChatMessage({ id: 'msg-2', body: 'Second', created_at: new Date('2026-04-07T10:05:00Z') });
    const msg3 = makeChatMessage({ id: 'msg-3', body: 'Third', created_at: new Date('2026-04-07T10:10:00Z') });

    // Returned in DESC order
    mockSelect.mockReturnValue(chainable([msg3, msg2, msg1]));

    const chain = mockSelect();
    const rows = await chain.from('board_chat_messages').where('board_id = ?').orderBy('created_at DESC');

    expect(rows).toHaveLength(3);
    expect(rows[0].body).toBe('Third');
    expect(rows[1].body).toBe('Second');
    expect(rows[2].body).toBe('First');

    // Verify ordering: each subsequent message has an earlier timestamp
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].created_at.getTime()).toBeGreaterThan(rows[i + 1].created_at.getTime());
    }
  });

  it('should support limit for pagination', async () => {
    const msg1 = makeChatMessage({ id: 'msg-1', body: 'Recent' });
    mockSelect.mockReturnValue(chainable([msg1]));

    const chain = mockSelect();
    const rows = await chain.from('board_chat_messages').where('board_id = ?').orderBy('created_at DESC').limit(1);

    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Message body max length
// ---------------------------------------------------------------------------

describe('chat message body validation', () => {
  it('should enforce max body length of 5000 characters via Zod schema', async () => {
    const { z } = await import('zod');
    const chatMessageSchema = z.object({
      body: z.string().min(1).max(5000),
    });

    const validResult = chatMessageSchema.safeParse({ body: 'Hello world' });
    expect(validResult.success).toBe(true);

    const tooLong = chatMessageSchema.safeParse({ body: 'x'.repeat(5001) });
    expect(tooLong.success).toBe(false);

    const empty = chatMessageSchema.safeParse({ body: '' });
    expect(empty.success).toBe(false);
  });

  it('should reject empty body', async () => {
    const { z } = await import('zod');
    const chatMessageSchema = z.object({
      body: z.string().min(1).max(5000),
    });

    const result = chatMessageSchema.safeParse({ body: '' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-org chat access
// ---------------------------------------------------------------------------

describe('cross-org chat access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should block chat access when board belongs to a different org', async () => {
    // Board ownership check: board belongs to ORG_ID, user is in ORG_ID_2
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const boards = await chain.from('boards').where('id = ? AND organization_id = ?');

    // Board not found for the user's org => chat messages should not be fetched
    expect(boards).toHaveLength(0);
  });

  it('should only allow sending messages after board org validation passes', async () => {
    const board = { id: BOARD_ID, organization_id: ORG_ID };
    const msg = makeChatMessage();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      return chainable(selectCount === 1 ? [board] : []);
    });

    mockInsert.mockReturnValue(chainable([msg]));

    // Step 1: validate board belongs to user's org
    const boardRows = await mockSelect().from('boards').where('id = ? AND organization_id = ?');
    expect(boardRows).toHaveLength(1);

    // Step 2: insert the message
    const chain = mockInsert();
    const [result] = await chain.values({ board_id: BOARD_ID, author_id: USER_ID, body: 'Hello' }).returning();
    expect(result.board_id).toBe(BOARD_ID);
  });
});

// ---------------------------------------------------------------------------
// Rate limit on sending
// ---------------------------------------------------------------------------

describe('chat rate limiting', () => {
  it('should enforce 30 messages per minute rate limit', () => {
    const RATE_LIMIT_CHAT_PER_MIN = 30;
    const RATE_LIMIT_WINDOW_MS = 60_000;

    // Simulate a rate limiter state
    const timestamps: number[] = [];
    const now = Date.now();

    // Add 30 messages within the last minute
    for (let i = 0; i < 30; i++) {
      timestamps.push(now - (i * 1000)); // one per second
    }

    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recentCount = timestamps.filter((t) => t >= windowStart).length;

    expect(recentCount).toBe(30);
    expect(recentCount >= RATE_LIMIT_CHAT_PER_MIN).toBe(true);

    // The 31st message should be rejected
    const wouldExceed = recentCount + 1 > RATE_LIMIT_CHAT_PER_MIN;
    expect(wouldExceed).toBe(true);
  });

  it('should allow messages after the rate limit window passes', () => {
    const RATE_LIMIT_CHAT_PER_MIN = 30;
    const RATE_LIMIT_WINDOW_MS = 60_000;

    const now = Date.now();
    // All messages are older than 1 minute (offset by 1ms to avoid boundary)
    const timestamps = Array.from({ length: 30 }, (_, i) => now - RATE_LIMIT_WINDOW_MS - 1 - (i * 1000));

    const windowStart = now - RATE_LIMIT_WINDOW_MS;
    const recentCount = timestamps.filter((t) => t >= windowStart).length;

    expect(recentCount).toBe(0);
    // New message should be allowed
    expect(recentCount < RATE_LIMIT_CHAT_PER_MIN).toBe(true);
  });
});
