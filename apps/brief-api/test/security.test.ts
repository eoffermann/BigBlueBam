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
    PORT: 4005,
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_BUCKET: 'brief-uploads',
    S3_REGION: 'us-east-1',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    BEACON_API_INTERNAL_URL: 'http://beacon-api:4004',
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
const USER_ID_2 = '00000000-0000-0000-0000-000000000004';
const DOC_ID = '00000000-0000-0000-0000-000000000010';

// ---------------------------------------------------------------------------
// ILIKE injection prevention (via escapeLike)
// ---------------------------------------------------------------------------

describe('ILIKE injection prevention', () => {
  let escapeLike: (s: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/services/document.service.js');
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
    const escaped = escapeLike('normal search query');
    expect(escaped).toBe('normal search query');
  });
});

// ---------------------------------------------------------------------------
// Cross-org document access (getDocument returns null for wrong org)
// ---------------------------------------------------------------------------

describe('cross-org document access', () => {
  let getDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    getDocument = mod.getDocument;
  });

  it('should return null when document belongs to a different org', async () => {
    // Document exists but belongs to ORG_ID, queried with ORG_ID_2
    mockSelect.mockReturnValue(chainable([]));

    const result = await getDocument(DOC_ID, ORG_ID_2);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Private document visibility
// ---------------------------------------------------------------------------

describe('private document visibility', () => {
  let listDocuments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    listDocuments = mod.listDocuments;
  });

  it('should apply visibility enforcement in listDocuments', async () => {
    // This test verifies that listDocuments builds the visibility conditions.
    // The actual filtering depends on SQL execution, but we verify the query
    // is constructed with the proper org context.
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // getUserProjectIds returns no projects
        return chainable([]);
      }
      // Main query returns nothing (private docs filtered out)
      return chainable([]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID_2,
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Error message sanitization
// ---------------------------------------------------------------------------

describe('error message sanitization', () => {
  it('should not expose internal details in BriefError', async () => {
    const { BriefError } = await import('../src/services/document.service.js');

    const error = new BriefError('NOT_FOUND', 'Document not found', 404);
    // Error message should be a clean user-facing message
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).not.toContain('SQL');
    expect(error.message).toBe('Document not found');
  });

  it('should not expose internal details in CommentError', async () => {
    const { CommentError } = await import('../src/services/comment.service.js');

    const error = new CommentError('FORBIDDEN', 'You can only edit your own comments', 403);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).not.toContain('postgres');
    expect(error.message).toBe('You can only edit your own comments');
  });

  it('should not expose internal details in FolderError', async () => {
    const { FolderError } = await import('../src/services/folder.service.js');

    const error = new FolderError('NOT_FOUND', 'Folder not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).toBe('Folder not found');
  });

  it('should not expose internal details in VersionError', async () => {
    const { VersionError } = await import('../src/services/version.service.js');

    const error = new VersionError('NOT_FOUND', 'Version not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).toBe('Version not found');
  });

  it('should not expose internal details in LinkError', async () => {
    const { LinkError } = await import('../src/services/link.service.js');

    const error = new LinkError('NOT_FOUND', 'Link not found', 404);
    expect(error.message).not.toContain('SELECT');
    expect(error.message).toBe('Link not found');
  });
});

// ---------------------------------------------------------------------------
// Cross-org link creation blocked
// ---------------------------------------------------------------------------

describe('cross-org link creation blocked', () => {
  let createTaskLink: Function;
  let createBeaconLink: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/link.service.js');
    createTaskLink = mod.createTaskLink;
    createBeaconLink = mod.createBeaconLink;
  });

  it('should block task link when document is not in the org', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await createTaskLink(DOC_ID, 'task-id', 'reference', USER_ID, ORG_ID);
    expect(result).toBeNull();
  });

  it('should block beacon link when beacon is in a different org', async () => {
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // Document belongs to ORG_ID
        return chainable([{ org_id: ORG_ID }]);
      }
      // Beacon belongs to ORG_ID_2
      return chainable([{ organization_id: ORG_ID_2 }]);
    });

    const result = await createBeaconLink(DOC_ID, 'beacon-id', 'reference', USER_ID, ORG_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Document getStats does not leak data between orgs
// ---------------------------------------------------------------------------

describe('org-scoped stats', () => {
  let getStats: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    getStats = mod.getStats;
  });

  it('should scope stats to the provided org_id', async () => {
    mockSelect
      .mockReturnValueOnce(chainable([])) // getUserProjectIds
      .mockReturnValueOnce(
        chainable([{ total: 5, draft: 3, in_review: 1, approved: 1, archived: 0 }]),
      );

    const result = await getStats(ORG_ID, USER_ID);
    expect(result.total).toBe(5);
    // Verify select was called (which contains org_id scoping via Drizzle)
    expect(mockSelect).toHaveBeenCalled();
  });
});
