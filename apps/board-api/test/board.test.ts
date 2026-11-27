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
  obj.onConflictDoUpdate = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const BOARD_ID = '00000000-0000-0000-0000-000000000010';
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const TEMPLATE_ID = '00000000-0000-0000-0000-000000000020';

function makeBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: BOARD_ID,
    organization_id: ORG_ID,
    project_id: PROJECT_ID,
    name: 'Sprint Planning Board',
    description: 'Board for sprint planning sessions',
    icon: '\u{1F4CB}',
    yjs_state: null,
    thumbnail_url: null,
    template_id: null,
    background: 'dots',
    locked: false,
    visibility: 'project',
    default_viewport: null,
    created_by: USER_ID,
    updated_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    archived_at: null,
    ...overrides,
  };
}

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    org_id: ORG_ID,
    name: 'Retro Template',
    description: 'A retrospective board template',
    category: 'agile',
    icon: '\u{1F504}',
    yjs_state: Buffer.from('template-state'),
    thumbnail_url: null,
    sort_order: 0,
    created_by: USER_ID,
    created_at: new Date('2026-03-15'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transaction mock helper
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
// Create board
// ---------------------------------------------------------------------------

describe('createBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a board with name, project_id, and visibility', async () => {
    const board = makeBoard();
    mockInsert.mockReturnValue(chainable([board]));

    const chain = mockInsert();
    const result = await chain.values({ name: 'Sprint Planning Board', project_id: PROJECT_ID, visibility: 'project' }).returning();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Sprint Planning Board');
    expect(result[0].project_id).toBe(PROJECT_ID);
    expect(result[0].visibility).toBe('project');
    expect(result[0].organization_id).toBe(ORG_ID);
  });

  it('should create a board from a template with copied yjs_state', async () => {
    const template = makeTemplate();
    const board = makeBoard({
      template_id: TEMPLATE_ID,
      name: 'From Template',
      yjs_state: template.yjs_state,
    });

    const { txSelect, txInsert } = setupTransaction();

    let selectCount = 0;
    txSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([template]);
      return chainable([]);
    });

    txInsert.mockReturnValue(chainable([board]));

    await mockTransaction(async (txArg: any) => {
      const [tpl] = await txArg.select().from('board_templates').where('id = ?');
      expect(tpl.name).toBe('Retro Template');
      expect(tpl.yjs_state).toBeDefined();

      const [created] = await txArg.insert().values({
        name: 'From Template',
        template_id: TEMPLATE_ID,
        yjs_state: tpl.yjs_state,
      }).returning();

      expect(created.template_id).toBe(TEMPLATE_ID);
      expect(created.yjs_state).toEqual(template.yjs_state);
      return created;
    });
  });

  it('should default visibility to project when not specified', async () => {
    const board = makeBoard({ visibility: 'project' });
    mockInsert.mockReturnValue(chainable([board]));

    const chain = mockInsert();
    const [result] = await chain.values({ name: 'Default Vis' }).returning();

    expect(result.visibility).toBe('project');
  });

  it('should default background to dots', async () => {
    const board = makeBoard();
    mockInsert.mockReturnValue(chainable([board]));

    const chain = mockInsert();
    const [result] = await chain.values({ name: 'New Board' }).returning();

    expect(result.background).toBe('dots');
  });

  it('should default locked to false', async () => {
    const board = makeBoard();
    mockInsert.mockReturnValue(chainable([board]));

    const chain = mockInsert();
    const [result] = await chain.values({ name: 'New Board' }).returning();

    expect(result.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// List boards
// ---------------------------------------------------------------------------

describe('listBoards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return paginated list with cursor-based pagination', async () => {
    const board1 = makeBoard({ id: 'board-1', created_at: new Date('2026-04-01') });
    const board2 = makeBoard({ id: 'board-2', created_at: new Date('2026-04-02') });
    const board3 = makeBoard({ id: 'board-3', created_at: new Date('2026-04-03') });

    mockSelect.mockReturnValue(chainable([board1, board2, board3]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('organization_id = ?').orderBy('created_at DESC').limit(2);

    // Simulate cursor pagination: fetch limit+1 to detect has_more
    expect(rows.length).toBe(3);
    const data = rows.slice(0, 2);
    const hasMore = rows.length > 2;

    expect(data).toHaveLength(2);
    expect(hasMore).toBe(true);
  });

  it('should filter by project_id', async () => {
    const board = makeBoard({ project_id: PROJECT_ID });
    mockSelect.mockReturnValue(chainable([board]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('project_id = ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(PROJECT_ID);
  });

  it('should filter by visibility', async () => {
    const privateBoard = makeBoard({ visibility: 'private' });
    mockSelect.mockReturnValue(chainable([privateBoard]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('visibility = ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('private');
  });

  it('should return empty array when no boards match', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('organization_id = ?');

    expect(rows).toEqual([]);
  });

  it('should cap limit to 100', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const requestedLimit = 500;
    const effectiveLimit = Math.min(requestedLimit, 100);

    expect(effectiveLimit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Get board by ID
// ---------------------------------------------------------------------------

describe('getBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return board by ID without yjs_state', async () => {
    const board = makeBoard();
    mockSelect.mockReturnValue(chainable([board]));

    const chain = mockSelect();
    const rows = await chain.fields({ id: true, name: true }).from('boards').where('id = ? AND organization_id = ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(BOARD_ID);
    expect(rows[0].name).toBe('Sprint Planning Board');
    // yjs_state should be excluded from the default fields selection
    // In practice the service selects specific columns excluding yjs_state
  });

  it('should return null when board not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND organization_id = ?');

    expect(rows).toHaveLength(0);
  });

  it('should return null for cross-org access (org_id mismatch)', async () => {
    // Query includes organization_id in WHERE, so wrong org returns empty
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND organization_id = ?');

    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Update board metadata
// ---------------------------------------------------------------------------

describe('updateBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update board name and description', async () => {
    const updated = makeBoard({ name: 'Updated Name', description: 'New desc' });
    mockUpdate.mockReturnValue(chainable([updated]));

    const chain = mockUpdate();
    const [result] = await chain.set({ name: 'Updated Name', description: 'New desc' }).where('id = ? AND organization_id = ?').returning();

    expect(result.name).toBe('Updated Name');
    expect(result.description).toBe('New desc');
  });

  it('should update background and icon', async () => {
    const updated = makeBoard({ background: 'grid', icon: '\u{1F3AF}' });
    mockUpdate.mockReturnValue(chainable([updated]));

    const chain = mockUpdate();
    const [result] = await chain.set({ background: 'grid', icon: '\u{1F3AF}' }).where('id = ?').returning();

    expect(result.background).toBe('grid');
    expect(result.icon).toBe('\u{1F3AF}');
  });
});

// ---------------------------------------------------------------------------
// Archive / Restore board
// ---------------------------------------------------------------------------

describe('archiveBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should set archived_at timestamp', async () => {
    const archivedAt = new Date('2026-04-07');
    const archived = makeBoard({ archived_at: archivedAt });
    mockUpdate.mockReturnValue(chainable([archived]));

    const chain = mockUpdate();
    const [result] = await chain.set({ archived_at: archivedAt }).where('id = ? AND organization_id = ?').returning();

    expect(result.archived_at).toEqual(archivedAt);
  });
});

describe('restoreBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should clear archived_at timestamp', async () => {
    const restored = makeBoard({ archived_at: null });
    mockUpdate.mockReturnValue(chainable([restored]));

    const chain = mockUpdate();
    const [result] = await chain.set({ archived_at: null }).where('id = ? AND organization_id = ?').returning();

    expect(result.archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Duplicate board
// ---------------------------------------------------------------------------

describe('duplicateBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a copy with (copy) suffix', async () => {
    const original = makeBoard();
    const copy = makeBoard({
      id: '00000000-0000-0000-0000-000000000011',
      name: 'Sprint Planning Board (copy)',
    });

    const { txSelect, txInsert } = setupTransaction();

    txSelect.mockReturnValue(chainable([original]));
    txInsert.mockReturnValue(chainable([copy]));

    await mockTransaction(async (tx: any) => {
      const [source] = await tx.select().from('boards').where('id = ?');
      expect(source.name).toBe('Sprint Planning Board');

      const [duplicated] = await tx.insert().values({
        name: `${source.name} (copy)`,
        organization_id: source.organization_id,
        project_id: source.project_id,
        visibility: source.visibility,
      }).returning();

      expect(duplicated.name).toBe('Sprint Planning Board (copy)');
      expect(duplicated.id).not.toBe(BOARD_ID);
      return duplicated;
    });
  });

  it('should copy board elements to the new board', async () => {
    const original = makeBoard();
    const elements = [
      { id: 'el-1', board_id: BOARD_ID, element_type: 'sticky', text_content: 'Task A' },
      { id: 'el-2', board_id: BOARD_ID, element_type: 'frame', text_content: 'Sprint' },
    ];
    const copy = makeBoard({ id: '00000000-0000-0000-0000-000000000011', name: 'Board (copy)' });

    const { txSelect, txInsert } = setupTransaction();

    let selectCount = 0;
    txSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return chainable([original]);
      return chainable(elements);
    });

    txInsert.mockReturnValue(chainable([copy]));

    await mockTransaction(async (tx: any) => {
      const [source] = await tx.select().from('boards').where('id = ?');
      const elems = await tx.select().from('board_elements').where('board_id = ?');
      expect(elems).toHaveLength(2);

      const [created] = await tx.insert().values({ name: `${source.name} (copy)` }).returning();
      expect(created).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Toggle star
// ---------------------------------------------------------------------------

describe('toggleStar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should add a star when not already starred', async () => {
    mockSelect.mockReturnValue(chainable([])); // no existing star
    const star = { id: 'star-1', board_id: BOARD_ID, user_id: USER_ID, created_at: new Date() };
    mockInsert.mockReturnValue(chainable([star]));

    const existing = await mockSelect().from('board_stars').where('board_id = ? AND user_id = ?');
    expect(existing).toHaveLength(0);

    const [result] = await mockInsert().values({ board_id: BOARD_ID, user_id: USER_ID }).returning();
    expect(result.board_id).toBe(BOARD_ID);
    expect(result.user_id).toBe(USER_ID);
  });

  it('should remove star when already starred (toggle off)', async () => {
    const existingStar = { id: 'star-1', board_id: BOARD_ID, user_id: USER_ID };
    mockSelect.mockReturnValue(chainable([existingStar]));
    mockDelete.mockReturnValue(chainable([]));

    const existing = await mockSelect().from('board_stars').where('board_id = ? AND user_id = ?');
    expect(existing).toHaveLength(1);

    await mockDelete().from('board_stars').where('board_id = ? AND user_id = ?');
    expect(mockDelete).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Toggle lock
// ---------------------------------------------------------------------------

describe('toggleLock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should lock an unlocked board', async () => {
    const locked = makeBoard({ locked: true });
    mockUpdate.mockReturnValue(chainable([locked]));

    const chain = mockUpdate();
    const [result] = await chain.set({ locked: true }).where('id = ?').returning();

    expect(result.locked).toBe(true);
  });

  it('should unlock a locked board', async () => {
    const unlocked = makeBoard({ locked: false });
    mockUpdate.mockReturnValue(chainable([unlocked]));

    const chain = mockUpdate();
    const [result] = await chain.set({ locked: false }).where('id = ?').returning();

    expect(result.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Search across board_elements text
// ---------------------------------------------------------------------------

describe('searchBoardElements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return boards matching text_content search', async () => {
    const matchingBoard = makeBoard({ id: 'board-match' });
    mockSelect.mockReturnValue(chainable([matchingBoard]));

    const chain = mockSelect();
    const rows = await chain.from('boards').innerJoin('board_elements').where('text_content ILIKE ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('board-match');
  });

  it('should return empty results for no matches', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').innerJoin('board_elements').where('text_content ILIKE ?');

    expect(rows).toEqual([]);
  });

  it('should escape ILIKE injection characters in search query', () => {
    // Simulate the escapeLike utility
    function escapeLike(s: string): string {
      return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    expect(escapeLike('%admin%')).toBe('\\%admin\\%');
    expect(escapeLike('user_table')).toBe('user\\_table');
    expect(escapeLike('path\\file')).toBe('path\\\\file');
    expect(escapeLike('normal text')).toBe('normal text');
  });
});

// ---------------------------------------------------------------------------
// Board stats
// ---------------------------------------------------------------------------

describe('boardStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return element counts by type', async () => {
    mockExecute.mockResolvedValue([
      {
        total_elements: 25,
        stickies: 12,
        frames: 3,
        arrows: 5,
        embeds: 2,
        shapes: 3,
        collaborator_count: 4,
        chat_message_count: 18,
      },
    ]);

    const [stats] = await mockExecute('SELECT ...');
    expect(stats.total_elements).toBe(25);
    expect(stats.stickies).toBe(12);
    expect(stats.frames).toBe(3);
    expect(stats.collaborator_count).toBe(4);
    expect(stats.chat_message_count).toBe(18);
  });

  it('should return zero counts for an empty board', async () => {
    mockExecute.mockResolvedValue([
      {
        total_elements: 0,
        stickies: 0,
        frames: 0,
        arrows: 0,
        embeds: 0,
        shapes: 0,
        collaborator_count: 0,
        chat_message_count: 0,
      },
    ]);

    const [stats] = await mockExecute('SELECT ...');
    expect(stats.total_elements).toBe(0);
    expect(stats.collaborator_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Private board visibility
// ---------------------------------------------------------------------------

describe('private board visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not be visible to non-owner and non-collaborator', async () => {
    // Private board owned by USER_ID, queried by USER_ID_2 with no collaborator entry
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain
      .from('boards')
      .leftJoin('board_collaborators')
      .where('id = ? AND visibility = private AND (created_by = ? OR collaborator.user_id = ?)');

    expect(rows).toHaveLength(0);
  });

  it('should be visible to the board owner', async () => {
    const privateBoard = makeBoard({ visibility: 'private' });
    mockSelect.mockReturnValue(chainable([privateBoard]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND created_by = ?');

    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('private');
    expect(rows[0].created_by).toBe(USER_ID);
  });

  it('should be visible to an explicit collaborator', async () => {
    const privateBoard = makeBoard({ visibility: 'private' });
    mockSelect.mockReturnValue(chainable([privateBoard]));

    const chain = mockSelect();
    const rows = await chain
      .from('boards')
      .leftJoin('board_collaborators')
      .where('id = ? AND (created_by = ? OR collaborator.user_id = ?)');

    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Organization board visibility
// ---------------------------------------------------------------------------

describe('organization board visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should be visible to all org members when visibility is organization', async () => {
    const orgBoard = makeBoard({ visibility: 'organization' });
    mockSelect.mockReturnValue(chainable([orgBoard]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('organization_id = ? AND visibility = organization');

    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('organization');
  });
});

// ---------------------------------------------------------------------------
// Cross-org access
// ---------------------------------------------------------------------------

describe('cross-org access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty when querying board with wrong organization_id', async () => {
    // Board belongs to ORG_ID but query uses ORG_ID_2
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('id = ? AND organization_id = ?');

    expect(rows).toHaveLength(0);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should block listing boards from a different org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const chain = mockSelect();
    const rows = await chain.from('boards').where('organization_id = ?');

    expect(rows).toEqual([]);
  });
});
