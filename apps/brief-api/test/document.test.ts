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
// Chain helpers — produce a Drizzle-like chainable query builder mock.
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
const PROJECT_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const DOC_ID = '00000000-0000-0000-0000-000000000010';

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    org_id: ORG_ID,
    project_id: PROJECT_ID,
    folder_id: null,
    title: 'Test Document',
    slug: 'test-document',
    yjs_state: null,
    plain_text: 'Some text content',
    html_snapshot: '<p>Some text content</p>',
    icon: null,
    cover_image_url: null,
    template_id: null,
    status: 'draft',
    visibility: 'project',
    pinned: false,
    word_count: 3,
    promoted_to_beacon_id: null,
    created_by: USER_ID,
    updated_by: USER_ID,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    archived_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// slugify — pure function, no DB dependency
// ---------------------------------------------------------------------------

describe('slugify', () => {
  let slugify: (title: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/services/document.service.js');
    slugify = mod.slugify;
  });

  it('should convert title to lowercase hyphenated slug', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('should strip non-alphanumeric characters', () => {
    expect(slugify('Deploy to Prod! (v2)')).toBe('deploy-to-prod-v2');
  });

  it('should collapse multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  it('should trim leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('should truncate to 200 characters', () => {
    const long = 'a'.repeat(300);
    expect(slugify(long).length).toBeLessThanOrEqual(200);
  });

  it('should handle all-special-character input', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });

  it('should preserve numbers', () => {
    expect(slugify('Release 3.2.1')).toBe('release-3-2-1');
  });
});

// ---------------------------------------------------------------------------
// escapeLike
// ---------------------------------------------------------------------------

describe('escapeLike', () => {
  let escapeLike: (s: string) => string;

  beforeEach(async () => {
    const mod = await import('../src/services/document.service.js');
    escapeLike = mod.escapeLike;
  });

  it('should escape % character', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('should escape _ character', () => {
    expect(escapeLike('hello_world')).toBe('hello\\_world');
  });

  it('should escape backslash character', () => {
    expect(escapeLike('path\\file')).toBe('path\\\\file');
  });

  it('should escape multiple special characters together', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });

  it('should leave normal strings untouched', () => {
    expect(escapeLike('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// BriefError
// ---------------------------------------------------------------------------

describe('BriefError', () => {
  it('should create error with code, message, and status', async () => {
    const { BriefError } = await import('../src/services/document.service.js');
    const error = new BriefError('NOT_FOUND', 'Document not found', 404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Document not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('BriefError');
  });

  it('should default to 400 status code', async () => {
    const { BriefError } = await import('../src/services/document.service.js');
    const error = new BriefError('VALIDATION', 'Bad data');
    expect(error.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// createDocument
// ---------------------------------------------------------------------------

describe('createDocument', () => {
  let createDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    createDocument = mod.createDocument;
  });

  it('should create a document with title, project_id, and visibility', async () => {
    const doc = makeDocument();

    // uniqueSlug: select to check slug existence
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      return chainable([]);
    });

    mockInsert.mockReturnValue(chainable([doc]));

    const result = await createDocument(
      { title: 'Test Document', project_id: PROJECT_ID, visibility: 'project' },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(result.title).toBe('Test Document');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should default title to Untitled when not provided', async () => {
    const doc = makeDocument({ title: 'Untitled', slug: 'untitled' });

    mockSelect.mockReturnValue(chainable([]));
    mockInsert.mockReturnValue(chainable([doc]));

    const result = await createDocument({}, USER_ID, ORG_ID);
    expect(result.title).toBe('Untitled');
  });

  it('should generate slug with random suffix when slug already exists', async () => {
    const doc = makeDocument({ slug: 'test-document-a1b2c3d4' });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // Slug already exists
        return chainable([{ slug: 'test-document' }]);
      }
      return chainable([]);
    });

    mockInsert.mockReturnValue(chainable([doc]));

    const result = await createDocument(
      { title: 'Test Document' },
      USER_ID,
      ORG_ID,
    );

    expect(result).toBeDefined();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should default visibility to project when not specified', async () => {
    const doc = makeDocument({ visibility: 'project' });

    mockSelect.mockReturnValue(chainable([]));
    mockInsert.mockReturnValue(chainable([doc]));

    const result = await createDocument({ title: 'Test' }, USER_ID, ORG_ID);
    expect(result.visibility).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// getDocument
// ---------------------------------------------------------------------------

describe('getDocument', () => {
  let getDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    getDocument = mod.getDocument;
  });

  it('should get document by UUID', async () => {
    const doc = makeDocument();
    mockSelect.mockReturnValue(chainable([doc]));

    const result = await getDocument(DOC_ID, ORG_ID);
    expect(result).toBeDefined();
    expect(result.id).toBe(DOC_ID);
  });

  it('should get document by slug', async () => {
    const doc = makeDocument();
    mockSelect.mockReturnValue(chainable([doc]));

    const result = await getDocument('test-document', ORG_ID);
    expect(result).toBeDefined();
    expect(result.slug).toBe('test-document');
  });

  it('should return null when document not found', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getDocument('nonexistent', ORG_ID);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateDocument
// ---------------------------------------------------------------------------

describe('updateDocument', () => {
  let updateDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    updateDocument = mod.updateDocument;
  });

  it('should update document metadata (title, status, visibility, icon)', async () => {
    const existing = makeDocument();
    const updated = makeDocument({
      title: 'Updated Title',
      status: 'in_review',
      visibility: 'organization',
      icon: '📄',
    });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([updated]));

    const result = await updateDocument(
      DOC_ID,
      { title: 'Updated Title', status: 'in_review', visibility: 'organization', icon: '📄' },
      USER_ID,
      ORG_ID,
    );

    expect(result.title).toBe('Updated Title');
    expect(result.status).toBe('in_review');
    expect(result.visibility).toBe('organization');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when document does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(
      updateDocument(DOC_ID, { title: 'New Title' }, USER_ID, ORG_ID),
    ).rejects.toThrow('Document not found');
  });
});

// ---------------------------------------------------------------------------
// archiveDocument
// ---------------------------------------------------------------------------

describe('archiveDocument', () => {
  let archiveDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    archiveDocument = mod.archiveDocument;
  });

  it('should archive a document (sets status=archived)', async () => {
    const existing = makeDocument({ status: 'draft' });
    const archived = makeDocument({ status: 'archived', archived_at: new Date() });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([archived]));

    const result = await archiveDocument(DOC_ID, USER_ID, ORG_ID);
    expect(result.status).toBe('archived');
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('should throw when document is already archived', async () => {
    const existing = makeDocument({ status: 'archived' });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(archiveDocument(DOC_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Document is already archived',
    );
  });

  it('should throw NOT_FOUND when document does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(archiveDocument(DOC_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Document not found',
    );
  });
});

// ---------------------------------------------------------------------------
// restoreDocument
// ---------------------------------------------------------------------------

describe('restoreDocument', () => {
  let restoreDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    restoreDocument = mod.restoreDocument;
  });

  it('should restore an archived document to draft status', async () => {
    const existing = makeDocument({ status: 'archived' });
    const restored = makeDocument({ status: 'draft', archived_at: null });

    mockSelect.mockReturnValue(chainable([existing]));
    mockUpdate.mockReturnValue(chainable([restored]));

    const result = await restoreDocument(DOC_ID, USER_ID, ORG_ID);
    expect(result.status).toBe('draft');
    expect(result.archived_at).toBeNull();
  });

  it('should throw INVALID_TRANSITION when document is not archived', async () => {
    const existing = makeDocument({ status: 'draft' });
    mockSelect.mockReturnValue(chainable([existing]));

    await expect(restoreDocument(DOC_ID, USER_ID, ORG_ID)).rejects.toThrow(
      "Cannot restore a document with status 'draft'; must be archived",
    );
  });

  it('should throw NOT_FOUND when document does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(restoreDocument(DOC_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Document not found',
    );
  });
});

// ---------------------------------------------------------------------------
// duplicateDocument
// ---------------------------------------------------------------------------

describe('duplicateDocument', () => {
  let duplicateDocument: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    duplicateDocument = mod.duplicateDocument;
  });

  it('should create a copy with (copy) suffix and draft status', async () => {
    const existing = makeDocument({ title: 'My Doc', status: 'approved' });
    const copy = makeDocument({
      id: '00000000-0000-0000-0000-000000000011',
      title: 'My Doc (copy)',
      slug: 'my-doc-copy',
      status: 'draft',
    });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // getDocumentById
        return chainable([existing]);
      }
      // uniqueSlug check
      return chainable([]);
    });

    mockInsert.mockReturnValue(chainable([copy]));

    const result = await duplicateDocument(DOC_ID, USER_ID, ORG_ID);
    expect(result.title).toBe('My Doc (copy)');
    expect(result.status).toBe('draft');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when source document does not exist', async () => {
    mockSelect.mockReturnValue(chainable([]));

    await expect(duplicateDocument(DOC_ID, USER_ID, ORG_ID)).rejects.toThrow(
      'Document not found',
    );
  });
});

// ---------------------------------------------------------------------------
// toggleStar
// ---------------------------------------------------------------------------

describe('toggleStar', () => {
  let toggleStar: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    toggleStar = mod.toggleStar;
  });

  it('should star a document when not already starred', async () => {
    mockSelect.mockReturnValue(chainable([]));
    mockInsert.mockReturnValue(chainable([{ id: 'star-1', document_id: DOC_ID, user_id: USER_ID }]));

    const result = await toggleStar(DOC_ID, USER_ID);
    expect(result.starred).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('should unstar a document when already starred', async () => {
    mockSelect.mockReturnValue(chainable([{ id: 'star-1' }]));
    mockDelete.mockReturnValue(chainable([{ id: 'star-1' }]));

    const result = await toggleStar(DOC_ID, USER_ID);
    expect(result.starred).toBe(false);
    expect(mockDelete).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getStarredDocuments
// ---------------------------------------------------------------------------

describe('getStarredDocuments', () => {
  let getStarredDocuments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    getStarredDocuments = mod.getStarredDocuments;
  });

  it('should return starred documents for the user', async () => {
    const doc = makeDocument();
    mockSelect.mockReturnValue(
      chainable([
        { document: doc, creator_name: 'Test User', project_name: 'Test Project' },
      ]),
    );

    const result = await getStarredDocuments(USER_ID, ORG_ID);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Test Document');
    expect(result[0].creator_name).toBe('Test User');
    // yjs_state should be stripped
    expect(result[0].yjs_state).toBeUndefined();
  });

  it('should return empty array when no starred documents', async () => {
    mockSelect.mockReturnValue(chainable([]));

    const result = await getStarredDocuments(USER_ID, ORG_ID);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRecentDocuments
// ---------------------------------------------------------------------------

describe('getRecentDocuments', () => {
  let getRecentDocuments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    getRecentDocuments = mod.getRecentDocuments;
  });

  it('should return recent documents with visibility enforcement', async () => {
    const doc = makeDocument();

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // getUserProjectIds
        return chainable([{ project_id: PROJECT_ID }]);
      }
      // Main query
      return chainable([
        { document: doc, creator_name: 'Test User', project_name: 'Test Project' },
      ]);
    });

    const result = await getRecentDocuments(USER_ID, ORG_ID, 20);
    expect(result).toHaveLength(1);
    expect(result[0].yjs_state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listDocuments
// ---------------------------------------------------------------------------

describe('listDocuments', () => {
  let listDocuments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    listDocuments = mod.listDocuments;
  });

  it('should return paginated list with cursor-based pagination', async () => {
    const doc1 = makeDocument({ id: 'doc-1', created_at: new Date('2026-04-01') });
    const doc2 = makeDocument({ id: 'doc-2', created_at: new Date('2026-04-02') });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        // getUserProjectIds
        return chainable([{ project_id: PROJECT_ID }]);
      }
      // Main query — return limit+1 to indicate has_more
      return chainable([
        { document: doc1, creator_name: 'User', project_name: 'Proj' },
        { document: doc2, creator_name: 'User', project_name: 'Proj' },
      ]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID,
      limit: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.meta.has_more).toBe(true);
    expect(result.meta.next_cursor).toBeDefined();
  });

  it('should filter by status', async () => {
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID,
      status: 'draft',
    });

    expect(result.data).toEqual([]);
    expect(result.meta.has_more).toBe(false);
  });

  it('should filter by project_id', async () => {
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should search documents by title with ILIKE', async () => {
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID,
      search: 'Test',
    });

    expect(result.data).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
  });

  it('should strip yjs_state from list response', async () => {
    const doc = makeDocument({ yjs_state: Buffer.from('data') });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([
        { document: doc, creator_name: 'User', project_name: 'Proj' },
      ]);
    });

    const result = await listDocuments({
      orgId: ORG_ID,
      userId: USER_ID,
    });

    expect(result.data[0].yjs_state).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// searchDocuments
// ---------------------------------------------------------------------------

describe('searchDocuments', () => {
  let searchDocuments: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/document.service.js');
    searchDocuments = mod.searchDocuments;
  });

  it('should search documents by query string', async () => {
    const doc = makeDocument({ title: 'API Design Guide' });

    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([
        { document: doc, creator_name: 'User', project_name: 'Proj' },
      ]);
    });

    const result = await searchDocuments('API', ORG_ID, USER_ID, {});
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('API Design Guide');
  });

  it('should escape ILIKE special characters in search query', async () => {
    let selectCount = 0;
    mockSelect.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) {
        return chainable([{ project_id: PROJECT_ID }]);
      }
      return chainable([]);
    });

    // Should not throw with special characters
    const result = await searchDocuments('100%_complete', ORG_ID, USER_ID, {});
    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalled();
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
    const mod = await import('../src/services/document.service.js');
    getStats = mod.getStats;
  });

  it('should return correct document counts by status', async () => {
    // First select call: getUserProjectIds (for visibility predicate)
    // Second select call: the stats aggregate query
    mockSelect
      .mockReturnValueOnce(chainable([])) // getUserProjectIds
      .mockReturnValueOnce(
        chainable([{ total: 10, draft: 5, in_review: 2, approved: 2, archived: 1 }]),
      );

    const result = await getStats(ORG_ID, USER_ID);
    expect(result.total).toBe(10);
    expect(result.draft).toBe(5);
    expect(result.in_review).toBe(2);
    expect(result.approved).toBe(2);
    expect(result.archived).toBe(1);
  });

  it('should return zero counts when no documents exist', async () => {
    mockSelect
      .mockReturnValueOnce(chainable([])) // getUserProjectIds
      .mockReturnValueOnce(chainable([])); // stats aggregate returns no rows

    const result = await getStats(ORG_ID, USER_ID);
    expect(result.total).toBe(0);
    expect(result.draft).toBe(0);
  });
});
