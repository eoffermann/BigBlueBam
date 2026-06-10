import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskLink } from '@bigbluebam/shared';

// Drizzle-style chain mocking, same pattern as dedupe-decisions.test.ts.
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    SESSION_SECRET: 'a'.repeat(32),
    SESSION_TTL_SECONDS: 604800,
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

import {
  MAX_TASK_LINKS,
  normalizeTaskLinks,
  parseInternalUrl,
  resolveInternalLink,
  resolveInternalLinkTitles,
  mirrorTaskEntityLinks,
} from '../src/services/task-links.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '33333333-3333-3333-3333-333333333333';
const DOC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DIAGRAM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOARD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// select().from().where().limit() -> rows
function mockSelectLimit(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

// select().from().innerJoin().where().limit() -> rows (the org-scoped
// bam.task resolver joins projects to filter on org_id).
function mockSelectJoinLimit(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  mockDb.select.mockReturnValueOnce({ from });
}

function mockInsertOnConflict() {
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mockDb.insert.mockReturnValueOnce({ values });
  return { values, onConflictDoNothing };
}

function fetchedLink(overrides: Partial<TaskLink> = {}): TaskLink {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    url: 'https://example.com/spec',
    title: 'Spec',
    title_source: 'user',
    added_at: '2026-06-01T00:00:00.000Z',
    added_by: USER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// normalizeTaskLinks
// ---------------------------------------------------------------------------

describe('normalizeTaskLinks', () => {
  it('stamps id, added_at, added_by and derives title_source', () => {
    const before = Date.now();
    const { links, truncated } = normalizeTaskLinks(
      [
        { url: 'https://example.com/a', title: 'Doc A' },
        { url: 'https://example.com/b' },
      ],
      USER_ID,
    );
    expect(truncated).toBe(false);
    expect(links).toHaveLength(2);

    expect(links[0]!.id).toMatch(UUID_RE);
    expect(links[0]!.title).toBe('Doc A');
    expect(links[0]!.title_source).toBe('user');
    expect(links[0]!.added_by).toBe(USER_ID);
    expect(new Date(links[0]!.added_at).getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(links[1]!.title).toBeNull();
    expect(links[1]!.title_source).toBe('none');
  });

  it('de-dupes by url, first occurrence wins', () => {
    const { links } = normalizeTaskLinks(
      [
        { url: 'https://example.com/a', title: 'First' },
        { url: 'https://example.com/a', title: 'Second' },
        { url: 'https://example.com/b' },
      ],
      USER_ID,
    );
    expect(links).toHaveLength(2);
    expect(links[0]!.title).toBe('First');
    expect(links[1]!.url).toBe('https://example.com/b');
  });

  it('trims urls and treats whitespace-only titles as untitled', () => {
    const { links } = normalizeTaskLinks(
      [{ url: '  https://example.com/a  ', title: '   ' }],
      USER_ID,
    );
    expect(links[0]!.url).toBe('https://example.com/a');
    expect(links[0]!.title).toBeNull();
    expect(links[0]!.title_source).toBe('none');
  });

  it('preserves provenance ONLY for links whose id matches an existing stored entry', () => {
    const existing: TaskLink[] = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        url: 'https://example.com/a',
        title: 'Fetched title',
        title_source: 'fetched',
        added_at: '2026-01-01T00:00:00.000Z',
        added_by: null,
      },
    ];
    // Same id + same title as the stored entry → provenance preserved.
    const { links } = normalizeTaskLinks(
      [
        {
          id: '55555555-5555-4555-8555-555555555555',
          url: 'https://example.com/a',
          title: 'Fetched title',
          title_source: 'fetched',
          added_at: '2026-01-01T00:00:00.000Z',
          added_by: null,
        },
      ],
      USER_ID,
      existing,
    );
    expect(links[0]).toEqual(existing[0]);
  });

  it('does NOT trust wire provenance for an unknown link id (anti-forgery)', () => {
    const before = Date.now();
    const { links } = normalizeTaskLinks(
      [
        {
          // id not present on the task → must be restamped, not trusted.
          id: '99999999-9999-4999-8999-999999999999',
          url: 'https://example.com/a',
          title: 'Forged fetched',
          title_source: 'fetched',
          added_at: '2000-01-01T00:00:00.000Z',
          added_by: '00000000-0000-0000-0000-000000000000',
        },
      ],
      USER_ID,
      [], // no existing links
    );
    // Forged 'fetched' downgraded to 'user'; added_by/added_at restamped.
    expect(links[0]!.title_source).toBe('user');
    expect(links[0]!.added_by).toBe(USER_ID);
    expect(new Date(links[0]!.added_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // A fresh id is generated (the forged one is ignored).
    expect(links[0]!.id).not.toBe('99999999-9999-4999-8999-999999999999');
  });

  it(`caps at ${MAX_TASK_LINKS} links and reports truncation`, () => {
    const input = Array.from({ length: MAX_TASK_LINKS + 5 }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    const { links, truncated } = normalizeTaskLinks(input, USER_ID);
    expect(links).toHaveLength(MAX_TASK_LINKS);
    expect(truncated).toBe(true);
  });

  it('does not report truncation when overflow entries are duplicates', () => {
    const input = Array.from({ length: MAX_TASK_LINKS }, (_, i) => ({
      url: `https://example.com/${i}`,
    }));
    input.push({ url: 'https://example.com/0' });
    const { links, truncated } = normalizeTaskLinks(input, USER_ID);
    expect(links).toHaveLength(MAX_TASK_LINKS);
    expect(truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseInternalUrl
// ---------------------------------------------------------------------------

describe('parseInternalUrl', () => {
  it('parses brief document paths, relative and absolute', () => {
    const expected = { dst_type: 'brief.document', id: DOC_ID };
    expect(parseInternalUrl(`/brief/documents/${DOC_ID}`)).toEqual(expected);
    expect(parseInternalUrl(`https://bam.example.com/brief/documents/${DOC_ID}`)).toEqual(
      expected,
    );
  });

  it('tolerates query strings, hashes, and trailing segments', () => {
    expect(parseInternalUrl(`/brief/documents/${DOC_ID}?tab=history#h1`)).toEqual({
      dst_type: 'brief.document',
      id: DOC_ID,
    });
    expect(parseInternalUrl(`/brief/documents/${DOC_ID}/edit`)).toEqual({
      dst_type: 'brief.document',
      id: DOC_ID,
    });
  });

  it('lowercases uuids for stable entity ids', () => {
    expect(parseInternalUrl(`/blueprint/d/${DIAGRAM_ID.toUpperCase()}`)).toEqual({
      dst_type: 'blueprint.diagram',
      id: DIAGRAM_ID,
    });
  });

  it('parses blueprint diagram and board paths', () => {
    expect(parseInternalUrl(`/blueprint/d/${DIAGRAM_ID}`)).toEqual({
      dst_type: 'blueprint.diagram',
      id: DIAGRAM_ID,
    });
    expect(parseInternalUrl(`http://localhost/board/${BOARD_ID}`)).toEqual({
      dst_type: 'board.board',
      id: BOARD_ID,
    });
  });

  it('parses task ref paths', () => {
    expect(parseInternalUrl('/b3/tasks/ref/MAGE-38')).toEqual({
      dst_type: 'bam.task',
      ref: 'MAGE-38',
    });
    expect(parseInternalUrl('https://bam.example.com/b3/tasks/ref/FRND-123')).toEqual({
      dst_type: 'bam.task',
      ref: 'FRND-123',
    });
  });

  it('rejects non-suite and malformed urls', () => {
    expect(parseInternalUrl('https://docs.google.com/document/d/xyz')).toBeNull();
    expect(parseInternalUrl('/board/help')).toBeNull();
    expect(parseInternalUrl('/board/not-a-uuid')).toBeNull();
    expect(parseInternalUrl('/brief/documents/123')).toBeNull();
    expect(parseInternalUrl('/b3/tasks/ref/lowercase but spaced')).toBeNull();
    expect(parseInternalUrl('not a url at all')).toBeNull();
    expect(parseInternalUrl('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveInternalLink
// ---------------------------------------------------------------------------

describe('resolveInternalLink', () => {
  it('resolves a task ref via tasks.human_id, org-scoped through projects', async () => {
    mockSelectJoinLimit([{ id: TASK_ID, title: 'Ship the importer' }]);
    const resolved = await resolveInternalLink('/b3/tasks/ref/MAGE-38', ORG_ID);
    expect(resolved).toEqual({
      title: 'Ship the importer',
      dst_type: 'bam.task',
      dst_id: TASK_ID,
    });
  });

  it('resolves a brief document title', async () => {
    mockSelectLimit([{ title: 'Q3 Launch Spec' }]);
    const resolved = await resolveInternalLink(`/brief/documents/${DOC_ID}`, ORG_ID);
    expect(resolved).toEqual({
      title: 'Q3 Launch Spec',
      dst_type: 'brief.document',
      dst_id: DOC_ID,
    });
  });

  it('resolves blueprint diagram and board names', async () => {
    mockSelectLimit([{ name: 'Auth Flow' }]);
    expect(await resolveInternalLink(`/blueprint/d/${DIAGRAM_ID}`, ORG_ID)).toEqual({
      title: 'Auth Flow',
      dst_type: 'blueprint.diagram',
      dst_id: DIAGRAM_ID,
    });

    mockSelectLimit([{ name: 'Sprint Retro' }]);
    expect(await resolveInternalLink(`/board/${BOARD_ID}`, ORG_ID)).toEqual({
      title: 'Sprint Retro',
      dst_type: 'board.board',
      dst_id: BOARD_ID,
    });
  });

  it('returns null when the target row does not exist (or is in another org)', async () => {
    mockSelectLimit([]);
    expect(await resolveInternalLink(`/brief/documents/${DOC_ID}`, ORG_ID)).toBeNull();
  });

  it('returns null for external urls without touching the db', async () => {
    expect(
      await resolveInternalLink('https://docs.google.com/document/d/xyz', ORG_ID),
    ).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveInternalLinkTitles
// ---------------------------------------------------------------------------

describe('resolveInternalLinkTitles', () => {
  it('keeps a user title but STILL mirrors a resolved internal link', async () => {
    // §5.2 + acceptance line 286: user-labeled internal links must still
    // join the cross-app graph. The title is preserved; a mirror is collected.
    mockSelectLimit([{ title: 'Server-side title (ignored)' }]);
    const link = fetchedLink({ url: `https://bam.example.com/brief/documents/${DOC_ID}` });
    const { links, mirrors } = await resolveInternalLinkTitles([link], ORG_ID);
    expect(links).toEqual([link]); // user title untouched
    expect(mirrors).toEqual([{ dst_type: 'brief.document', dst_id: DOC_ID }]);
  });

  it('fills untitled internal links and collects mirrors', async () => {
    mockSelectLimit([{ title: 'Q3 Launch Spec' }]);
    const link = fetchedLink({
      url: `https://bam.example.com/brief/documents/${DOC_ID}`,
      title: null,
      title_source: 'none',
    });
    const { links, mirrors } = await resolveInternalLinkTitles([link], ORG_ID);
    expect(links[0]!.title).toBe('Q3 Launch Spec');
    expect(links[0]!.title_source).toBe('fetched');
    expect(mirrors).toEqual([{ dst_type: 'brief.document', dst_id: DOC_ID }]);
  });

  it('leaves untitled external links for the worker to backfill', async () => {
    const link = fetchedLink({
      url: 'https://docs.google.com/document/d/xyz',
      title: null,
      title_source: 'none',
    });
    const { links, mirrors } = await resolveInternalLinkTitles([link], ORG_ID);
    expect(links[0]!.title).toBeNull();
    expect(links[0]!.title_source).toBe('none');
    expect(mirrors).toEqual([]);
  });

  it('keeps the link untitled when the internal target row is missing', async () => {
    mockSelectLimit([]);
    const link = fetchedLink({
      url: `/blueprint/d/${DIAGRAM_ID}`,
      title: null,
      title_source: 'none',
    });
    const { links, mirrors } = await resolveInternalLinkTitles([link], ORG_ID);
    expect(links[0]!.title).toBeNull();
    expect(mirrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mirrorTaskEntityLinks
// ---------------------------------------------------------------------------

describe('mirrorTaskEntityLinks', () => {
  it('inserts idempotent references rows for each mirror', async () => {
    const { values, onConflictDoNothing } = mockInsertOnConflict();
    await mirrorTaskEntityLinks(TASK_ID, ORG_ID, USER_ID, [
      { dst_type: 'brief.document', dst_id: DOC_ID },
    ]);
    expect(values).toHaveBeenCalledWith({
      org_id: ORG_ID,
      src_type: 'bam.task',
      src_id: TASK_ID,
      dst_type: 'brief.document',
      dst_id: DOC_ID,
      link_kind: 'references',
      created_by: USER_ID,
    });
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('skips self-links', async () => {
    await mirrorTaskEntityLinks(TASK_ID, ORG_ID, USER_ID, [
      { dst_type: 'bam.task', dst_id: TASK_ID },
    ]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
