import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB. Mirrors apps/beacon-api/test/beacon.test.ts so these tests slot
// into the existing suite without tripping on env/config mismatches.
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockExecute = vi.fn();

// The upsert runs in one transaction (#280); the mock tx is the same statement mocks.
const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({ select: mockSelect, insert: mockInsert, update: mockUpdate, execute: mockExecute }),
);

vi.mock('../src/db/index.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: vi.fn(),
    transaction: mockTransaction,
    execute: mockExecute,
  },
  connection: { end: vi.fn() },
}));

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

vi.mock('../src/lib/sanitize.js', () => ({
  sanitizeHtml: (html: string) => html,
}));

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
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  obj.leftJoin = vi.fn().mockReturnValue(obj);
  obj.onConflictDoUpdate = vi.fn().mockReturnValue(obj);
  obj.onConflictDoNothing = vi.fn().mockReturnValue(obj);
  obj.groupBy = vi.fn().mockReturnValue(obj);
  return obj;
}

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const ENTRY_ID = '00000000-0000-0000-0000-000000000200';

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    slug: 'deploy-runbook',
    title: 'Deploy Runbook',
    summary: null,
    body_markdown: '## Steps',
    body_html: null,
    version: 1,
    status: 'Draft',
    visibility: 'Project',
    created_by: USER_ID,
    owned_by: USER_ID,
    project_id: null,
    organization_id: ORG_ID,
    expires_at: new Date('2026-07-01'),
    last_verified_at: null,
    last_verified_by: null,
    verification_count: 0,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
    retired_at: null,
    vector_id: null,
    metadata: {},
    ...overrides,
  };
}

describe('upsertEntryBySlug — validation', () => {
  let upsertEntryBySlug: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/entry-upsert.service.js');
    upsertEntryBySlug = mod.upsertEntryBySlug;
  });

  it('rejects empty slug', async () => {
    await expect(
      upsertEntryBySlug(
        { slug: '', title: 't', body_markdown: 'b' },
        USER_ID,
        ORG_ID,
      ),
    ).rejects.toThrow(/slug/);
  });

  it('rejects empty title', async () => {
    await expect(
      upsertEntryBySlug(
        { slug: 's', title: '', body_markdown: 'b' },
        USER_ID,
        ORG_ID,
      ),
    ).rejects.toThrow(/title/);
  });

  it('rejects empty body_markdown', async () => {
    await expect(
      upsertEntryBySlug(
        { slug: 's', title: 't', body_markdown: '' },
        USER_ID,
        ORG_ID,
      ),
    ).rejects.toThrow(/body_markdown/);
  });
});

describe('upsertEntryBySlug — create path', () => {
  let upsertEntryBySlug: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/entry-upsert.service.js');
    upsertEntryBySlug = mod.upsertEntryBySlug;
  });

  it('returns created=true on first insert, inside one transaction', async () => {
    // resolveDefaultExpiryDays uses db.execute; return empty rows so it
    // falls back to the 90-day default.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // INSERT ... ON CONFLICT DO NOTHING RETURNING → the new row.
    const entryInsert = chainable([makeEntry()]);
    mockInsert.mockReturnValueOnce(entryInsert);
    // Version insert.
    mockInsert.mockReturnValueOnce(chainable([{ id: 'ver-1' }]));

    const result = await upsertEntryBySlug(
      { slug: 'deploy-runbook', title: 'Deploy Runbook', body_markdown: '## Steps' },
      USER_ID,
      ORG_ID,
    );

    expect(result.created).toBe(true);
    expect(result.data.slug).toBe('deploy-runbook');
    expect(result.idempotency_key).toBe('slug:deploy-runbook');
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(entryInsert.onConflictDoNothing).toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('applies the loser of a create race as the next version instead of dropping it (#280)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // The parallel writer won the insert: ON CONFLICT DO NOTHING returns no row.
    mockInsert.mockReturnValueOnce(chainable([]));
    const update = chainable([makeEntry({ version: 2, title: 'Mine', body_markdown: 'my body' })]);
    mockUpdate.mockReturnValueOnce(update);
    const snapshot = chainable([{ id: 'ver-2' }]);
    mockInsert.mockReturnValueOnce(snapshot);

    const result = await upsertEntryBySlug(
      { slug: 'deploy-runbook', title: 'Mine', body_markdown: 'my body' },
      USER_ID,
      ORG_ID,
    );

    expect(result.created).toBe(false);
    expect(result.data.version).toBe(2);
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mine', body_markdown: 'my body' }));
    expect(snapshot.values).toHaveBeenCalledWith(expect.objectContaining({ version: 2, body_markdown: 'my body' }));
  });
});

describe('upsertEntryBySlug — update path', () => {
  let upsertEntryBySlug: Function;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const mod = await import('../src/services/entry-upsert.service.js');
    upsertEntryBySlug = mod.upsertEntryBySlug;
  });

  it('returns created=false and bumps version on an existing slug', async () => {
    const existing = makeEntry({ version: 3 });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    // The slug exists: the insert does nothing.
    mockInsert.mockReturnValueOnce(chainable([]));
    // Update bumps version in SQL and returns the row it wrote.
    mockUpdate.mockReturnValueOnce(
      chainable([{ ...existing, version: 4, title: 'Deploy Runbook v2' }]),
    );
    // Version snapshot insert, numbered from the returned row.
    const snapshot = chainable([{ id: 'ver-4' }]);
    mockInsert.mockReturnValueOnce(snapshot);

    const result = await upsertEntryBySlug(
      {
        slug: 'deploy-runbook',
        title: 'Deploy Runbook v2',
        body_markdown: '## Updated Steps',
      },
      USER_ID,
      ORG_ID,
    );

    expect(result.created).toBe(false);
    expect(result.data.version).toBe(4);
    expect(result.idempotency_key).toBe('slug:deploy-runbook');
    expect(snapshot.values).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));
  });
});
