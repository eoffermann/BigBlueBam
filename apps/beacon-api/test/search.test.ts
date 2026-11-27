import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module before importing services
vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

// Mock env
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 4004,
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
    S3_BUCKET: 'beacon-uploads',
    S3_REGION: 'us-east-1',
    QDRANT_URL: 'http://qdrant:6333',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    COOKIE_SECURE: false,
  },
}));

// Mock Qdrant client
vi.mock('../src/lib/qdrant.js', () => ({
  getQdrantClient: vi.fn(() => ({
    getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    createCollection: vi.fn().mockResolvedValue({}),
    createPayloadIndex: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    search: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [] }),
  })),
  checkQdrantHealth: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Chunker tests
// ---------------------------------------------------------------------------

describe('chunker.service', () => {
  describe('chunkBeacon', () => {
    let chunkBeacon: typeof import('../src/services/chunker.service.js').chunkBeacon;

    beforeEach(async () => {
      const mod = await import('../src/services/chunker.service.js');
      chunkBeacon = mod.chunkBeacon;
    });

    it('produces a title_summary chunk combining title and summary', () => {
      const chunks = chunkBeacon(
        {
          title: 'Deploy Guide',
          summary: 'How to deploy to staging',
          body_markdown: 'Some body text',
        },
        [],
        [],
      );

      const titleChunk = chunks.find((c) => c.chunk_type === 'title_summary');
      expect(titleChunk).toBeDefined();
      expect(titleChunk!.text).toBe('Deploy Guide — How to deploy to staging');
      expect(titleChunk!.char_offset).toBe(0);
    });

    it('produces title_summary with just title when no summary', () => {
      const chunks = chunkBeacon(
        { title: 'Deploy Guide', summary: null, body_markdown: 'body' },
        [],
        [],
      );

      const titleChunk = chunks.find((c) => c.chunk_type === 'title_summary');
      expect(titleChunk!.text).toBe('Deploy Guide');
    });

    it('splits body at ## headings into body_section chunks', () => {
      const body = `# Intro

Some intro text

## Prerequisites

You need Node.js 22.

## Setup

Run npm install.`;

      const chunks = chunkBeacon(
        { title: 'Test', summary: null, body_markdown: body },
        [],
        [],
      );

      const bodySections = chunks.filter((c) => c.chunk_type === 'body_section');
      expect(bodySections.length).toBe(3);

      // First section is the intro (before first ##)
      expect(bodySections[0]!.text).toContain('Intro');
      expect(bodySections[0]!.text).toContain('Some intro text');

      // Second section starts at ## Prerequisites
      expect(bodySections[1]!.text).toContain('Prerequisites');
      expect(bodySections[1]!.text).toContain('Node.js 22');

      // Third section starts at ## Setup
      expect(bodySections[2]!.text).toContain('Setup');
      expect(bodySections[2]!.text).toContain('npm install');
    });

    it('produces a single body_section for body without ## headings', () => {
      const chunks = chunkBeacon(
        { title: 'Test', summary: null, body_markdown: 'Just some text without headings.' },
        [],
        [],
      );

      const bodySections = chunks.filter((c) => c.chunk_type === 'body_section');
      expect(bodySections.length).toBe(1);
      expect(bodySections[0]!.text).toBe('Just some text without headings.');
    });

    it('produces a tags_metadata chunk with tags and linked titles', () => {
      const chunks = chunkBeacon(
        { title: 'Test', summary: null, body_markdown: 'body' },
        ['devops', 'deployment', 'staging'],
        [
          { title: 'Rollback Procedures', link_type: 'RelatedTo' },
          { title: 'CI Config', link_type: 'DependsOn' },
        ],
      );

      const metaChunk = chunks.find((c) => c.chunk_type === 'tags_metadata');
      expect(metaChunk).toBeDefined();
      expect(metaChunk!.text).toContain('Topics: devops, deployment, staging.');
      expect(metaChunk!.text).toContain('Related: Rollback Procedures (RelatedTo)');
      expect(metaChunk!.text).toContain('CI Config (DependsOn)');
      expect(metaChunk!.char_offset).toBe(-1); // synthetic
    });

    it('omits tags_metadata chunk when no tags and no links', () => {
      const chunks = chunkBeacon(
        { title: 'Test', summary: null, body_markdown: 'body' },
        [],
        [],
      );

      const metaChunk = chunks.find((c) => c.chunk_type === 'tags_metadata');
      expect(metaChunk).toBeUndefined();
    });

    it('handles empty body_markdown', () => {
      const chunks = chunkBeacon(
        { title: 'Test', summary: 'A summary', body_markdown: '' },
        ['tag1'],
        [],
      );

      const bodySections = chunks.filter((c) => c.chunk_type === 'body_section');
      expect(bodySections.length).toBe(0);

      // Should still have title_summary and tags_metadata
      expect(chunks.find((c) => c.chunk_type === 'title_summary')).toBeDefined();
      expect(chunks.find((c) => c.chunk_type === 'tags_metadata')).toBeDefined();
    });
  });

  describe('splitBody', () => {
    let splitBody: typeof import('../src/services/chunker.service.js').splitBody;

    beforeEach(async () => {
      const mod = await import('../src/services/chunker.service.js');
      splitBody = mod.splitBody;
    });

    it('splits large sections at ~512 char boundary', () => {
      const longSection = 'A'.repeat(600);
      const body = `## Big Section\n\n${longSection}`;

      const sections = splitBody(body);
      expect(sections.length).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array for empty body', () => {
      expect(splitBody('')).toEqual([]);
      expect(splitBody('   ')).toEqual([]);
    });

    it('preserves heading in section', () => {
      const body = '## My Heading\n\nSome content here.';
      const sections = splitBody(body);
      expect(sections.length).toBe(1);
      expect(sections[0]!.heading).toBe('My Heading');
    });
  });
});

// ---------------------------------------------------------------------------
// Embedding service tests
// ---------------------------------------------------------------------------

describe('embedding.service', () => {
  it('embedTexts returns zero vectors of dimension 1024', async () => {
    const { embedTexts, DENSE_DIMENSION } = await import('../src/services/embedding.service.js');

    const vectors = await embedTexts(['hello world', 'test query']);
    expect(vectors.length).toBe(2);
    expect(vectors[0]!.length).toBe(DENSE_DIMENSION);
    expect(vectors[0]!.every((v) => v === 0)).toBe(true);
    expect(vectors[1]!.length).toBe(DENSE_DIMENSION);
  });

  it('embedSparse returns empty sparse vectors', async () => {
    const { embedSparse } = await import('../src/services/embedding.service.js');

    const vectors = await embedSparse(['hello', 'world']);
    expect(vectors.length).toBe(2);
    expect(vectors[0]!.indices).toEqual([]);
    expect(vectors[0]!.values).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Search response formatting tests
// ---------------------------------------------------------------------------

describe('search response formatting', () => {
  it('returns correct SearchResponse structure with empty results', async () => {
    // Mock Qdrant search to return empty
    vi.doMock('../src/lib/qdrant.js', () => ({
      getQdrantClient: vi.fn(() => ({
        search: vi.fn().mockResolvedValue([]),
        scroll: vi.fn().mockResolvedValue({ points: [] }),
      })),
    }));

    const { hybridSearch } = await import('../src/services/search.service.js');

    // Mock db to return empty results for fulltext search
    const { db } = await import('../src/db/index.js');
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    (db.select as any).mockReturnValue(mockChain);

    const result = await hybridSearch(
      {
        query: 'nonexistent',
        filters: { organization_id: '00000000-0000-0000-0000-000000000001' },
        options: { top_k: 10 },
      },
      'user-1',
    );

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('total_candidates');
    expect(result).toHaveProperty('retrieval_stages');
    expect(result.retrieval_stages).toHaveProperty('semantic_hits');
    expect(result.retrieval_stages).toHaveProperty('tag_expansion_hits');
    expect(result.retrieval_stages).toHaveProperty('link_traversal_hits');
    expect(result.retrieval_stages).toHaveProperty('fulltext_fallback_hits');
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('returns zero results with total_candidates for top_k=0 (count mode)', async () => {
    const { db } = await import('../src/db/index.js');
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    (db.select as any).mockReturnValue(mockChain);

    const { hybridSearch } = await import('../src/services/search.service.js');

    const result = await hybridSearch(
      {
        query: 'deployment',
        filters: { organization_id: '00000000-0000-0000-0000-000000000001' },
        options: { top_k: 0 },
      },
      'user-1',
    );

    expect(result.results).toEqual([]);
    expect(typeof result.total_candidates).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Saved query CRUD tests
// ---------------------------------------------------------------------------

describe('saved-query.service', () => {
  let saveQuery: typeof import('../src/services/saved-query.service.js').saveQuery;
  let listQueries: typeof import('../src/services/saved-query.service.js').listQueries;
  let getQuery: typeof import('../src/services/saved-query.service.js').getQuery;
  let deleteQuery: typeof import('../src/services/saved-query.service.js').deleteQuery;
  let db: any;

  const userId = '00000000-0000-0000-0000-000000000001';
  const orgId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/services/saved-query.service.js');
    saveQuery = mod.saveQuery;
    listQueries = mod.listQueries;
    getQuery = mod.getQuery;
    deleteQuery = mod.deleteQuery;
    db = (await import('../src/db/index.js')).db;
  });

  describe('saveQuery', () => {
    it('inserts a saved query and returns it', async () => {
      const mockQuery = {
        id: 'query-1',
        name: 'My Deployment Search',
        description: null,
        query_body: { query: 'deployment', filters: {} },
        owner_id: userId,
        scope: 'Private',
        project_id: null,
        organization_id: orgId,
        created_at: new Date(),
        updated_at: new Date(),
      };

      const mockChain = {
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([mockQuery]),
      };
      (db.insert as any).mockReturnValue(mockChain);

      const result = await saveQuery(
        { name: 'My Deployment Search', query_body: { query: 'deployment', filters: {} } },
        userId,
        orgId,
      );

      expect(result).toEqual(mockQuery);
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('listQueries', () => {
    it('returns queries matching scope conditions', async () => {
      const mockQueries = [
        {
          id: 'q1',
          name: 'Private Query',
          scope: 'Private',
          owner_id: userId,
          organization_id: orgId,
        },
        {
          id: 'q2',
          name: 'Org Query',
          scope: 'Organization',
          owner_id: 'other-user',
          organization_id: orgId,
        },
      ];

      const mockChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockQueries),
      };
      (db.select as any).mockReturnValue(mockChain);

      const result = await listQueries(userId, orgId);
      expect(result).toEqual(mockQueries);
    });
  });

  describe('getQuery', () => {
    it('returns a query by ID if user owns it', async () => {
      const mockQuery = {
        id: 'q1',
        name: 'My Query',
        organization_id: orgId,
        owner_id: userId,
        scope: 'Private',
      };

      const mockChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockQuery]),
      };
      (db.select as any).mockReturnValue(mockChain);

      const result = await getQuery('q1', userId, orgId);
      expect(result).toEqual(mockQuery);
    });

    it('returns null for private query owned by someone else', async () => {
      const mockQuery = {
        id: 'q1',
        name: 'Their Query',
        organization_id: orgId,
        owner_id: 'other-user',
        scope: 'Private',
      };

      const mockChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockQuery]),
      };
      (db.select as any).mockReturnValue(mockChain);

      const result = await getQuery('q1', userId, orgId);
      expect(result).toBeNull();
    });

    it('returns null when query not found', async () => {
      const mockChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      (db.select as any).mockReturnValue(mockChain);

      const result = await getQuery('nonexistent', userId, orgId);
      expect(result).toBeNull();
    });

    it('returns shared query to non-owner', async () => {
      const mockQuery = {
        id: 'q1',
        name: 'Org Query',
        organization_id: orgId,
        owner_id: 'other-user',
        scope: 'Organization',
      };

      const mockChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockQuery]),
      };
      (db.select as any).mockReturnValue(mockChain);

      const result = await getQuery('q1', userId, orgId);
      expect(result).toEqual(mockQuery);
    });
  });

  describe('deleteQuery', () => {
    it('deletes a query owned by the user', async () => {
      const mockQuery = { id: 'q1', organization_id: orgId, owner_id: userId };

      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockQuery]),
      };
      const deleteChain = {
        where: vi.fn().mockResolvedValue(undefined),
      };

      (db.select as any).mockReturnValue(selectChain);
      (db.delete as any).mockReturnValue(deleteChain);

      const result = await deleteQuery('q1', userId, orgId);
      expect(result).toEqual({ deleted: true });
    });

    it('throws FORBIDDEN when non-owner tries to delete', async () => {
      const mockQuery = { id: 'q1', organization_id: orgId, owner_id: 'other-user' };

      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockQuery]),
      };
      (db.select as any).mockReturnValue(selectChain);

      await expect(deleteQuery('q1', userId, orgId)).rejects.toThrow('Only the query owner can delete it');
    });

    it('throws NOT_FOUND when query does not exist', async () => {
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      (db.select as any).mockReturnValue(selectChain);

      await expect(deleteQuery('nonexistent', userId, orgId)).rejects.toThrow('Saved query not found');
    });
  });
});

// ---------------------------------------------------------------------------
// Tag expansion logic tests
// ---------------------------------------------------------------------------

describe('tag expansion logic', () => {
  let tagExpansionSearch: typeof import('../src/services/search.service.js').tagExpansionSearch;
  let db: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/services/search.service.js');
    tagExpansionSearch = mod.tagExpansionSearch;
    db = (await import('../src/db/index.js')).db;
  });

  it('returns empty array when no beacon IDs provided', async () => {
    const result = await tagExpansionSearch([], 'org-1');
    expect(result).toEqual([]);
  });

  it('finds beacons sharing >= 2 tags', async () => {
    // Mock: source beacons have tags [devops, staging, deployment]
    const sourceTags = [
      { tag: 'devops' },
      { tag: 'staging' },
      { tag: 'deployment' },
    ];

    // Mock: other beacons and their tag counts
    const tagMatchRows = [
      // beacon-A has devops + staging (2 matches — should be included)
      { beacon_id: 'beacon-A', tag: 'devops' },
      { beacon_id: 'beacon-A', tag: 'staging' },
      // beacon-B has only devops (1 match — should be excluded)
      { beacon_id: 'beacon-B', tag: 'devops' },
      // beacon-C has devops + deployment + staging (3 matches — should be included)
      { beacon_id: 'beacon-C', tag: 'devops' },
      { beacon_id: 'beacon-C', tag: 'deployment' },
      { beacon_id: 'beacon-C', tag: 'staging' },
    ];

    let selectCallCount = 0;
    (db.select as any).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // First call: get tags for source beacons
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(sourceTags),
        };
      }
      // Second call: find matching beacons
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(tagMatchRows),
      };
    });

    const result = await tagExpansionSearch(['source-1', 'source-2'], 'org-1');

    // Should include beacon-A (2 tags) and beacon-C (3 tags), not beacon-B (1 tag)
    expect(result).toContain('beacon-A');
    expect(result).toContain('beacon-C');
    expect(result).not.toContain('beacon-B');
  });

  it('excludes input beacons from results', async () => {
    const sourceTags = [{ tag: 'devops' }, { tag: 'staging' }];

    const tagMatchRows = [
      // source-1 itself would match (but should be excluded)
      { beacon_id: 'source-1', tag: 'devops' },
      { beacon_id: 'source-1', tag: 'staging' },
      // external beacon
      { beacon_id: 'beacon-X', tag: 'devops' },
      { beacon_id: 'beacon-X', tag: 'staging' },
    ];

    let selectCallCount = 0;
    (db.select as any).mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue(sourceTags),
        };
      }
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(tagMatchRows),
      };
    });

    const result = await tagExpansionSearch(['source-1'], 'org-1');

    expect(result).not.toContain('source-1');
    expect(result).toContain('beacon-X');
  });
});

// ---------------------------------------------------------------------------
// Link traversal logic tests
// ---------------------------------------------------------------------------

describe('link traversal logic', () => {
  let linkTraversalSearch: typeof import('../src/services/search.service.js').linkTraversalSearch;
  let db: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../src/services/search.service.js');
    linkTraversalSearch = mod.linkTraversalSearch;
    db = (await import('../src/db/index.js')).db;
  });

  it('returns empty array when no beacon IDs provided', async () => {
    const result = await linkTraversalSearch([], 'org-1');
    expect(result).toEqual([]);
  });

  it('follows links in both directions', async () => {
    const sourceLinks = [
      { source_id: 'beacon-1', target_id: 'beacon-linked-a' },
    ];
    const targetLinks = [
      { source_id: 'beacon-linked-b', target_id: 'beacon-1' },
    ];

    const makeChain = (rows: any) => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    });

    (db.select as any)
      .mockReturnValueOnce(makeChain(sourceLinks))
      .mockReturnValueOnce(makeChain(targetLinks));

    const result = await linkTraversalSearch(['beacon-1'], 'org-1');

    expect(result).toContain('beacon-linked-a');
    expect(result).toContain('beacon-linked-b');
    expect(result).not.toContain('beacon-1');
  });
});
