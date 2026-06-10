import { describe, it, expect, vi, beforeEach } from 'vitest';

// Drizzle-style chain mocking, same pattern as task-links.service.test.ts.
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

// createTask is the delegation target — mocked so the import service is tested
// in isolation. Each call records the input it received so tests can assert on
// the links / priority / phase passed through.
const { createTaskMock } = vi.hoisted(() => ({ createTaskMock: vi.fn() }));
vi.mock('../src/services/task.service.js', () => ({
  createTask: createTaskMock,
}));

import {
  applyValueMap,
  buildRowLinks,
  normalizePriority,
  runImport,
  previewImport,
  type ImportBody,
} from '../src/services/import.service.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const REPORTER_ID = '22222222-2222-2222-2222-222222222222';
const PHASE_ID = '33333333-3333-3333-3333-333333333333';

// ── select mocking ──────────────────────────────────────────────────────
// Two terminal shapes are exercised by the service:
//   select().from().where().limit()      → getDefaultPhase
//   select().from().where()              → loadExisting* (no limit, awaited)
// We build a single fluent stub whose .where() is itself awaitable AND
// chainable into .limit()/.orderBy(), returning a queued result each call.

function queueSelect(...resultsInOrder: unknown[][]) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    const rows = resultsInOrder[call] ?? [];
    call++;
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    // where() resolves to the rows when awaited, but also exposes limit/orderBy.
    const wherePromise: Promise<unknown[]> & { limit: typeof limit; orderBy: typeof orderBy } =
      Object.assign(Promise.resolve(rows), { limit, orderBy });
    const where = vi.fn().mockReturnValue(wherePromise);
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createTaskMock.mockReset();
  createTaskMock.mockResolvedValue({ id: 'task-id' });
});

// ===========================================================================
// applyValueMap (hit / null / passthrough / case-trim)
// ===========================================================================

describe('applyValueMap', () => {
  const maps: ImportBody['value_maps'] = {
    priority: { P0: 'critical', P1: 'high', P4: null },
  };

  it('maps a known value (hit)', () => {
    expect(applyValueMap('priority', 'P0', maps)).toEqual({ mapped: true, value: 'critical' });
  });

  it('maps to null (leave unset)', () => {
    expect(applyValueMap('priority', 'P4', maps)).toEqual({ mapped: true, value: null });
  });

  it('passes through values not in the map', () => {
    expect(applyValueMap('priority', 'P9', maps)).toEqual({ mapped: false });
  });

  it('matches exact-after-trim, case-insensitive', () => {
    expect(applyValueMap('priority', '  p0  ', maps)).toEqual({ mapped: true, value: 'critical' });
    expect(applyValueMap('priority', 'P1', { priority: { ' p1 ': 'high' } })).toEqual({
      mapped: true,
      value: 'high',
    });
  });

  it('returns passthrough when the field has no map', () => {
    expect(applyValueMap('phase_name', 'WIP', maps)).toEqual({ mapped: false });
  });
});

// ===========================================================================
// buildRowLinks (multi-URL cell, bare domain, empty skip)
// ===========================================================================

describe('buildRowLinks', () => {
  it('splits a multi-URL cell into one link each', () => {
    const { links } = buildRowLinks(
      { Docs: 'https://a.com/x https://b.com/y,https://c.com/z' },
      [{ column: 'Docs' }],
    );
    expect(links.map((l) => l.url)).toEqual([
      'https://a.com/x',
      'https://b.com/y',
      'https://c.com/z',
    ]);
  });

  it('prepends https:// to bare domains', () => {
    const { links } = buildRowLinks({ Spec: 'example.com/spec' }, [{ column: 'Spec' }]);
    expect(links[0]!.url).toBe('https://example.com/spec');
  });

  it('applies the static column label as the link title', () => {
    const { links } = buildRowLinks({ Spec: 'https://a.com' }, [
      { column: 'Spec', label: 'Spec Doc' },
    ]);
    expect(links[0]!.title).toBe('Spec Doc');
  });

  it('skips empty cells (never errors)', () => {
    const { links, invalid } = buildRowLinks({ Spec: '   ' }, [{ column: 'Spec' }]);
    expect(links).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it('collects non-URL junk as invalid but keeps the valid tokens', () => {
    const { links, invalid } = buildRowLinks({ Spec: 'see Bob https://a.com' }, [
      { column: 'Spec' },
    ]);
    expect(links.map((l) => l.url)).toEqual(['https://a.com']);
    // "see" and "Bob" are bare tokens with no dot → invalid.
    expect(invalid.map((i) => i.value)).toEqual(['see', 'Bob']);
  });

  it('returns nothing when no link_mappings configured', () => {
    expect(buildRowLinks({ Spec: 'https://a.com' }, undefined)).toEqual({
      links: [],
      invalid: [],
    });
  });
});

// ===========================================================================
// normalizePriority
// ===========================================================================

describe('normalizePriority', () => {
  it('defaults to medium for empty', () => {
    expect(normalizePriority(undefined)).toBe('medium');
    expect(normalizePriority('')).toBe('medium');
  });
  it('passes through valid priorities case-insensitively', () => {
    expect(normalizePriority('HIGH')).toBe('high');
  });
  it('maps Jira-ish values', () => {
    expect(normalizePriority('Highest')).toBe('critical');
    expect(normalizePriority('Lowest')).toBe('low');
  });
});

// ===========================================================================
// runImport — value-map + link_mappings + empty-cell skip
// ===========================================================================

describe('runImport', () => {
  it('applies value maps and link mappings, passing them to createTask', async () => {
    // getDefaultPhase → one phase row. No 'skip' strategy → no title-set query.
    queueSelect([{ id: PHASE_ID, is_start: true }]);

    const body: ImportBody = {
      rows: [{ Feature: 'Build it', Prio: 'P0', Doc: 'example.com/spec' }],
      mapping: { title: 'Feature', priority: 'Prio' },
      value_maps: { priority: { P0: 'critical' } },
      link_mappings: [{ column: 'Doc', label: 'Spec' }],
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const [projectId, input, reporterId] = createTaskMock.mock.calls[0]!;
    expect(projectId).toBe(PROJECT_ID);
    expect(reporterId).toBe(REPORTER_ID);
    expect(input.title).toBe('Build it');
    expect(input.priority).toBe('critical');
    expect(input.phase_id).toBe(PHASE_ID);
    expect(input.links).toEqual([{ url: 'https://example.com/spec', title: 'Spec' }]);
  });

  it('leaves priority unset when the value map maps to null', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    const body: ImportBody = {
      rows: [{ Feature: 'X', Prio: 'P4' }],
      mapping: { title: 'Feature', priority: 'Prio' },
      value_maps: { priority: { P4: null } },
    };
    await runImport(PROJECT_ID, body, REPORTER_ID);
    const input = createTaskMock.mock.calls[0]![1];
    expect(input.priority).toBeUndefined();
  });

  it('falls back to the normalizer for unmapped priority values (passthrough)', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    const body: ImportBody = {
      rows: [{ Feature: 'X', Prio: 'Highest' }],
      mapping: { title: 'Feature', priority: 'Prio' },
      value_maps: { priority: { P0: 'critical' } },
    };
    await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(createTaskMock.mock.calls[0]![1].priority).toBe('critical');
  });

  it('skips rows with empty title without erroring on empty cells elsewhere', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    const body: ImportBody = {
      rows: [
        { Feature: '   ', Doc: '' },
        { Feature: 'Real', Doc: '   ' },
      ],
      mapping: { title: 'Feature' },
      link_mappings: [{ column: 'Doc' }],
    };
    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual(['Row 1: missing title']);
    // The created task carries NO links (the only link cell was empty).
    expect(createTaskMock.mock.calls[0]![1].links).toBeUndefined();
  });

  it('skips duplicate titles under duplicate_strategy: skip (batched title query)', async () => {
    // getDefaultPhase, then loadExistingTitleSet returns one existing title.
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ title: 'Existing Task' }],
    );
    const body: ImportBody = {
      rows: [
        { Feature: 'existing task' }, // case-insensitive dup of existing
        { Feature: 'New One' },
        { Feature: 'new one' }, // in-file dup of the just-imported "New One"
      ],
      mapping: { title: 'Feature' },
      options: { duplicate_strategy: 'skip' },
    };
    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0]![1].title).toBe('New One');
  });

  it('creates duplicates under the default create strategy (no title query)', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    const body: ImportBody = {
      rows: [{ Feature: 'A' }, { Feature: 'A' }],
      mapping: { title: 'Feature' },
    };
    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.imported).toBe(2);
    // Only getDefaultPhase ran — no batched title query under 'create'.
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('tallies per-row failures and keeps going (partial success)', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    createTaskMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'ok' });
    const body: ImportBody = {
      rows: [{ Feature: 'A' }, { Feature: 'B' }],
      mapping: { title: 'Feature' },
    };
    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual(['Row 1: boom']);
  });
});

// ===========================================================================
// previewImport — writes nothing, parity on counts
// ===========================================================================

describe('previewImport', () => {
  it('reports counts, new phases, unmapped values, invalid urls (writes nothing)', async () => {
    // loadExistingTitleSet, loadExistingPhaseNames, loadExistingLabelNames.
    queueSelect(
      [{ title: 'Existing Task' }],
      [{ name: 'To Do' }],
      [],
    );
    const body: ImportBody = {
      rows: [
        { Feature: 'existing task', Status: 'WIP', Prio: 'P9', Doc: 'see Bob' },
        { Feature: 'Fresh', Status: 'To Do', Prio: 'P0' },
      ],
      mapping: { title: 'Feature', phase_name: 'Status', priority: 'Prio' },
      value_maps: { priority: { P0: 'critical' } },
      link_mappings: [{ column: 'Doc' }],
      options: { duplicate_strategy: 'skip' },
    };

    const result = await previewImport(PROJECT_ID, body, REPORTER_ID);

    expect(result.total_rows).toBe(2);
    expect(result.will_skip).toBe(1); // "existing task" is a dup under skip
    expect(result.will_create).toBe(1);
    expect(result.duplicate_titles).toEqual([{ row: 1, title: 'existing task' }]);
    // "WIP" is a new phase (passthrough, not in existing); "To Do" exists.
    expect(result.new_phases).toContain('WIP');
    expect(result.new_phases).not.toContain('To Do');
    // P9 is unmapped priority passthrough; P0 is mapped → not listed.
    expect(result.unmapped_values.priority).toContain('P9');
    expect(result.unmapped_values.priority).not.toContain('P0');
    // "WIP" passthrough is reported as an unmapped phase value too.
    expect(result.unmapped_values.phase_name).toContain('WIP');
    // "see"/"Bob" are invalid URLs.
    expect(result.invalid_urls).toEqual([
      { row: 1, column: 'Doc', value: 'see' },
      { row: 1, column: 'Doc', value: 'Bob' },
    ]);
    // Dry-run never writes.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('preview will_create matches runImport imported count (parity)', async () => {
    const rows = [
      { Feature: 'One' },
      { Feature: 'Two' },
      { Feature: '   ' }, // skipped (no title) in both
    ];

    // preview: title-set + phase-names + label-names (all empty → no dups).
    queueSelect([], [], []);
    const preview = await previewImport(
      PROJECT_ID,
      { rows, mapping: { title: 'Feature' } },
      REPORTER_ID,
    );

    // commit: getDefaultPhase only (create strategy).
    queueSelect([{ id: PHASE_ID, is_start: true }]);
    const commit = await runImport(
      PROJECT_ID,
      { rows, mapping: { title: 'Feature' } },
      REPORTER_ID,
    );

    expect(preview.will_create).toBe(commit.imported);
    expect(preview.will_skip).toBe(commit.skipped);
  });

  it('reports unresolved assignees', async () => {
    // title-set, phase-names, label-names, then findUserByEmail (no user).
    queueSelect([], [], [], []);
    const body: ImportBody = {
      rows: [{ Feature: 'X', Owner: 'ghost@example.com' }],
      mapping: { title: 'Feature', assignee_email: 'Owner' },
    };
    const result = await previewImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.unresolved_assignees).toEqual([
      { row: 1, value: 'ghost@example.com' },
    ]);
  });
});
