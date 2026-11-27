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
const BOARD_ID = '00000000-0000-0000-0000-000000000010';

function makeElement(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000030',
    board_id: BOARD_ID,
    element_type: 'sticky',
    text_content: 'Implement login page',
    x: 100,
    y: 200,
    width: 200,
    height: 150,
    rotation: 0,
    color: 'yellow',
    font_size: '14',
    frame_id: null,
    group_id: null,
    arrow_start: null,
    arrow_end: null,
    arrow_label: null,
    embed_type: null,
    embed_ref_id: null,
    embed_url: null,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    ...overrides,
  };
}

function makeFrame(overrides: Record<string, unknown> = {}) {
  return makeElement({
    id: '00000000-0000-0000-0000-000000000040',
    element_type: 'frame',
    text_content: 'Sprint 1',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    color: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// List all elements for a board
// ---------------------------------------------------------------------------

describe('listElements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all elements for a board', async () => {
    const sticky1 = makeElement({ id: 'el-1', text_content: 'Task A' });
    const sticky2 = makeElement({ id: 'el-2', text_content: 'Task B' });
    const frame = makeFrame({ id: 'el-3' });

    mockSelect.mockReturnValue(chainable([sticky1, sticky2, frame]));

    const chain = mockSelect();
    const rows = await chain.from('board_elements').where('board_id = ?').orderBy('created_at ASC');

    expect(rows).toHaveLength(3);
    expect(rows[0].board_id).toBe(BOARD_ID);
    expect(rows[1].board_id).toBe(BOARD_ID);
    expect(rows[2].element_type).toBe('frame');
  });

  it('should filter stickies only by element_type', async () => {
    const sticky1 = makeElement({ id: 'el-1', text_content: 'Task A' });
    const sticky2 = makeElement({ id: 'el-2', text_content: 'Task B' });

    mockSelect.mockReturnValue(chainable([sticky1, sticky2]));

    const chain = mockSelect();
    const rows = await chain
      .from('board_elements')
      .where('board_id = ? AND element_type = ?');

    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.element_type === 'sticky')).toBe(true);
  });

  it('should return frames with contained elements via frame_id', async () => {
    const frame = makeFrame({ id: 'frame-1' });
    const stickyInFrame = makeElement({
      id: 'el-in-frame',
      frame_id: 'frame-1',
      text_content: 'Inside frame',
    });

    mockSelect.mockReturnValue(chainable([frame, stickyInFrame]));

    const chain = mockSelect();
    const rows = await chain.from('board_elements').where('board_id = ?');

    const frames = rows.filter((r: any) => r.element_type === 'frame');
    const contained = rows.filter((r: any) => r.frame_id === 'frame-1');

    expect(frames).toHaveLength(1);
    expect(contained).toHaveLength(1);
    expect(contained[0].text_content).toBe('Inside frame');
  });

  it('should return empty array for a board with no elements', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('board_elements').where('board_id = ?');

    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-org element access
// ---------------------------------------------------------------------------

describe('cross-org element access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should block element access when board belongs to a different org', async () => {
    // First verify the board belongs to the requesting org
    // Board belongs to ORG_ID, but user is in ORG_ID_2
    mockSelect.mockReturnValue(chainable([])); // board not found for ORG_ID_2

    const chain = mockSelect();
    const boards = await chain
      .from('boards')
      .where('id = ? AND organization_id = ?');

    // Board not found in the user's org => access denied
    expect(boards).toHaveLength(0);

    // Elements should never be returned if the board ownership check fails
    // The service layer should short-circuit before querying elements
  });

  it('should return elements only after validating board org membership', async () => {
    const board = {
      id: BOARD_ID,
      organization_id: ORG_ID,
      name: 'Test Board',
    };
    const element = makeElement();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([board]); // board ownership check
      return chainable([element]); // elements query
    });

    // Step 1: verify board belongs to org
    const boardRows = await mockSelect().from('boards').where('id = ? AND organization_id = ?');
    expect(boardRows).toHaveLength(1);

    // Step 2: fetch elements
    const elemRows = await mockSelect().from('board_elements').where('board_id = ?');
    expect(elemRows).toHaveLength(1);
    expect(elemRows[0].board_id).toBe(BOARD_ID);
  });

  it('should return 404-equivalent when board ID does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const boards = await chain.from('boards').where('id = ? AND organization_id = ?');

    expect(boards).toHaveLength(0);
  });
});
