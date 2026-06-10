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
const { createTaskMock, updateTaskMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(),
  updateTaskMock: vi.fn(),
}));
vi.mock('../src/services/task.service.js', () => ({
  createTask: createTaskMock,
  updateTask: updateTaskMock,
}));

import {
  applyValueMap,
  buildRowLinks,
  normalizePriority,
  runImport,
  previewImport,
  coerceCustomFieldCell,
  coerceDate,
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
    // orderBy() is awaitable (resolves to rows, for select().where().orderBy())
    // AND exposes .limit() (for select().where().orderBy().limit()). This
    // covers both the loader shape (awaited orderBy) and the paginated shape.
    const orderBy = vi.fn().mockReturnValue(
      Object.assign(Promise.resolve(rows), { limit }),
    );
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
  updateTaskMock.mockReset();
  updateTaskMock.mockResolvedValue({ id: 'task-id' });
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

  // Round-trip contract: the CSV export emits links as "Title <url>; Title2
  // <url2>" (export.routes.ts formatLinksForCsv). Re-importing that exact cell
  // must yield the URLs cleanly — no angle-bracket junk in invalid[].
  it('round-trips the "Title <url>; ..." export shape', () => {
    const exported = 'Spec <https://x.com/a>; <https://y.com/b>';
    const { links, invalid } = buildRowLinks({ Links: exported }, [{ column: 'Links' }]);
    expect(links.map((l) => l.url)).toEqual(['https://x.com/a', 'https://y.com/b']);
    expect(invalid).toEqual([]);
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

// ===========================================================================
// runImport — duplicate_strategy: 'update' (Phase 3, Agent B)
// ===========================================================================

const EXISTING_TASK_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_TASK_ID = '55555555-5555-5555-5555-555555555555';

describe('runImport — update strategy', () => {
  it('matches an existing task by human_id and overwrites mapped non-empty cells', async () => {
    // select #1 getDefaultPhase, #2 loadUpdateMatchIndex.
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Old Title' }],
    );

    const body: ImportBody = {
      rows: [{ Ref: 'FRND-7', Feature: 'New Title', Prio: 'high' }],
      mapping: { title: 'Feature', human_id: 'Ref', priority: 'Prio' },
      options: { duplicate_strategy: 'update' },
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result).toEqual({ imported: 0, skipped: 0, updated: 1, errors: [] });
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    const [taskId, patch, actorId] = updateTaskMock.mock.calls[0]!;
    expect(taskId).toBe(EXISTING_TASK_ID);
    expect(actorId).toBe(REPORTER_ID);
    expect(patch.title).toBe('New Title');
    expect(patch.priority).toBe('high');
  });

  it('matches by exact title (case-insensitive) when no human_id mapping', async () => {
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-9', title: 'Build Login' }],
    );

    const body: ImportBody = {
      rows: [{ Feature: '  build login  ', Prio: 'low' }],
      mapping: { title: 'Feature', priority: 'Prio' },
      options: { duplicate_strategy: 'update' },
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result.updated).toBe(1);
    expect(updateTaskMock.mock.calls[0]![0]).toBe(EXISTING_TASK_ID);
    expect(updateTaskMock.mock.calls[0]![1].priority).toBe('low');
  });

  it('leaves empty cells untouched (skip-empty preserves existing values)', async () => {
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Keep Me' }],
    );

    // Priority + due_date cells are blank — they must NOT appear in the patch.
    const body: ImportBody = {
      rows: [{ Ref: 'FRND-7', Feature: 'Keep Me', Prio: '   ', Due: '' }],
      mapping: { title: 'Feature', human_id: 'Ref', priority: 'Prio', due_date: 'Due' },
      options: { duplicate_strategy: 'update' },
    };

    await runImport(PROJECT_ID, body, REPORTER_ID);

    const patch = updateTaskMock.mock.calls[0]![1];
    expect(patch).not.toHaveProperty('priority');
    expect(patch).not.toHaveProperty('due_date');
    // Title was non-empty so it is patched.
    expect(patch.title).toBe('Keep Me');
  });

  it('merges links as a union by url (existing wins, no clobber)', async () => {
    // select #1 getDefaultPhase, #2 loadUpdateMatchIndex, #3 loadTaskLinks.
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'T' }],
      [
        {
          links: [
            {
              id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
              url: 'https://a.com/keep',
              title: 'Existing A',
              title_source: 'user',
              added_at: '2026-01-01T00:00:00.000Z',
              added_by: null,
            },
          ],
        },
      ],
    );

    const body: ImportBody = {
      rows: [{ Ref: 'FRND-7', Feature: 'T', Doc: 'https://a.com/keep https://b.com/new' }],
      mapping: { title: 'Feature', human_id: 'Ref' },
      link_mappings: [{ column: 'Doc' }],
      options: { duplicate_strategy: 'update' },
    };

    await runImport(PROJECT_ID, body, REPORTER_ID);

    const patch = updateTaskMock.mock.calls[0]![1];
    const urls = patch.links.map((l: { url: string }) => l.url);
    // Existing url kept once; new url appended. No duplicate of a.com/keep.
    expect(urls).toEqual(['https://a.com/keep', 'https://b.com/new']);
    // The existing entry kept its provenance (title preserved, not clobbered).
    const kept = patch.links.find((l: { url: string }) => l.url === 'https://a.com/keep');
    expect(kept.title).toBe('Existing A');
  });

  it('unmatched rows fall through to create', async () => {
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: OTHER_TASK_ID, human_id: 'FRND-1', title: 'Something Else' }],
    );

    const body: ImportBody = {
      rows: [{ Feature: 'Brand New Task' }],
      mapping: { title: 'Feature' },
      options: { duplicate_strategy: 'update' },
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result).toEqual({ imported: 1, skipped: 0, updated: 0, errors: [] });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0]![1].title).toBe('Brand New Task');
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  it('mixes update + create across rows in one import', async () => {
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Existing' }],
    );

    const body: ImportBody = {
      rows: [
        { Feature: 'Existing' }, // matches by title → update
        { Feature: 'Fresh' }, // no match → create
      ],
      mapping: { title: 'Feature' },
      options: { duplicate_strategy: 'update' },
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result.updated).toBe(1);
    expect(result.imported).toBe(1);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
  });

  it('applies a mapped custom field on update, merged over existing values', async () => {
    // selects: #1 getDefaultPhase, #2 loadUpdateMatchIndex,
    //          #3 resolveCustomFieldDefs (existing 'Notes' text def),
    //          #4 loadTaskCustomFields (existing custom_fields on the task).
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'T' }],
      [{ id: 'def-notes', name: 'Notes', field_type: 'text', options: null, position: 1 }],
      [{ custom_fields: { Notes: 'old', Keep: 'untouched' } }],
    );

    const body: ImportBody = {
      rows: [{ Feature: 'T', N: 'new' }],
      mapping: { title: 'Feature', human_id: 'Ref' },
      custom_field_mapping: [
        { column: 'N', field_name: 'Notes', field_type: 'text', create_if_missing: false },
      ],
      options: { duplicate_strategy: 'update' },
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);

    expect(result.updated).toBe(1);
    const patch = updateTaskMock.mock.calls[0]![1];
    // Mapped field overwritten; a pre-existing custom field NOT in the import
    // is preserved (merge, not replace).
    expect(patch.custom_fields).toEqual({ Notes: 'new', Keep: 'untouched' });
  });
});

// ===========================================================================
// previewImport — update strategy will_update counting (Phase 3, Agent B)
// ===========================================================================

describe('previewImport — update strategy', () => {
  it('counts will_update and lists matches (by human_id and by title)', async () => {
    // preview selects: #1 title-set, #2 phase-names, #3 label-names,
    // #4 custom-field-defs, #5 loadUpdateMatchIndex.
    queueSelect(
      [{ title: 'Existing One' }, { title: 'Existing Two' }],
      [],
      [],
      [],
      [
        { id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Existing One' },
        { id: OTHER_TASK_ID, human_id: 'FRND-8', title: 'Existing Two' },
      ],
    );

    const body: ImportBody = {
      rows: [
        { Ref: 'FRND-7', Feature: 'Renamed in sheet' }, // matches by human_id
        { Ref: '', Feature: 'existing two' }, // matches by title (case-insensitive)
        { Ref: '', Feature: 'Totally New' }, // no match → create
      ],
      mapping: { title: 'Feature', human_id: 'Ref' },
      options: { duplicate_strategy: 'update' },
    };

    const result = await previewImport(PROJECT_ID, body, REPORTER_ID);

    expect(result.will_update).toBe(2);
    expect(result.will_create).toBe(1);
    expect(result.will_skip).toBe(0);
    expect(result.update_matches).toEqual([
      { row: 1, human_id: 'FRND-7', matched_by: 'human_id' },
      { row: 2, human_id: 'FRND-8', matched_by: 'title' },
    ]);
  });

  it('preview will_update matches runImport updated count (parity)', async () => {
    const rows = [
      { Feature: 'Existing One' }, // update
      { Feature: 'New Two' }, // create
    ];

    // preview: title-set, phase-names, label-names, custom-field-defs,
    // match-index.
    queueSelect(
      [{ title: 'Existing One' }],
      [],
      [],
      [],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Existing One' }],
    );
    const preview = await previewImport(
      PROJECT_ID,
      { rows, mapping: { title: 'Feature' }, options: { duplicate_strategy: 'update' } },
      REPORTER_ID,
    );

    // commit: getDefaultPhase, match-index.
    queueSelect(
      [{ id: PHASE_ID, is_start: true }],
      [{ id: EXISTING_TASK_ID, human_id: 'FRND-7', title: 'Existing One' }],
    );
    const commit = await runImport(
      PROJECT_ID,
      { rows, mapping: { title: 'Feature' }, options: { duplicate_strategy: 'update' } },
      REPORTER_ID,
    );

    expect(preview.will_update).toBe(commit.updated);
    expect(preview.will_create).toBe(commit.imported);
  });
});

// ===========================================================================
// coerceDate — date-locale toggle (us vs iso)
// ===========================================================================

describe('coerceDate', () => {
  it('reads ISO dates verbatim regardless of locale', () => {
    expect(coerceDate('2026-06-09', 'iso')).toBe('2026-06-09');
    expect(coerceDate('2026-06-09', 'us')).toBe('2026-06-09');
    expect(coerceDate('2026/6/9', 'iso')).toBe('2026-06-09');
  });

  it('reads ambiguous numeric dates per the toggle (us=MM/DD, iso=DD/MM)', () => {
    // 03/04/2026 is ambiguous: us → March 4, iso → April 3.
    expect(coerceDate('03/04/2026', 'us')).toBe('2026-03-04');
    expect(coerceDate('03/04/2026', 'iso')).toBe('2026-04-03');
  });

  it('disambiguates when a field exceeds 12 regardless of locale', () => {
    // 25/12/2026 can only be DD/MM; 12/25/2026 can only be MM/DD.
    expect(coerceDate('25/12/2026', 'us')).toBe('2026-12-25');
    expect(coerceDate('12/25/2026', 'iso')).toBe('2026-12-25');
  });

  it('expands 2-digit years and parses word-y dates', () => {
    expect(coerceDate('06/09/26', 'us')).toBe('2026-06-09');
    expect(coerceDate('June 9, 2026', 'iso')).toBe('2026-06-09');
  });

  it('returns null for unparseable values and empties', () => {
    expect(coerceDate('not a date', 'iso')).toBeNull();
    expect(coerceDate('   ', 'iso')).toBeNull();
    expect(coerceDate('99/99/2026', 'us')).toBeNull();
  });
});

// ===========================================================================
// coerceCustomFieldCell — coercion matrix ($1,200 / 85% / TRUE / #N/A / empty)
// ===========================================================================

describe('coerceCustomFieldCell', () => {
  it('coerces numbers, stripping $ , % and whitespace', () => {
    expect(coerceCustomFieldCell('$1,200', 'number', 'iso')).toEqual({ ok: true, value: 1200 });
    expect(coerceCustomFieldCell('85%', 'number', 'iso')).toEqual({ ok: true, value: 85 });
    expect(coerceCustomFieldCell('  -3.5 ', 'number', 'iso')).toEqual({ ok: true, value: -3.5 });
  });

  it('warns (ok:false) on uncoercible numbers like #N/A', () => {
    expect(coerceCustomFieldCell('#N/A', 'number', 'iso')).toEqual({
      ok: false,
      reason: 'not a number',
    });
  });

  it('coerces checkbox truthy/falsy tokens and warns otherwise', () => {
    for (const t of ['TRUE', 'yes', 'x', '1', 'Y']) {
      expect(coerceCustomFieldCell(t, 'checkbox', 'iso')).toEqual({ ok: true, value: true });
    }
    for (const f of ['false', 'no', '0', 'N']) {
      expect(coerceCustomFieldCell(f, 'checkbox', 'iso')).toEqual({ ok: true, value: false });
    }
    expect(coerceCustomFieldCell('maybe', 'checkbox', 'iso')).toEqual({
      ok: false,
      reason: 'not a boolean',
    });
  });

  it('coerces dates per locale and warns on garbage', () => {
    expect(coerceCustomFieldCell('03/04/2026', 'date', 'us')).toEqual({
      ok: true,
      value: '2026-03-04',
    });
    expect(coerceCustomFieldCell('nope', 'date', 'iso')).toEqual({
      ok: false,
      reason: 'unparseable date',
    });
  });

  it('emits select value + appendedOptions; multi_select comma-splits', () => {
    expect(coerceCustomFieldCell('High', 'select', 'iso')).toEqual({
      ok: true,
      value: 'High',
      appendedOptions: ['High'],
    });
    expect(coerceCustomFieldCell('A, B ,C', 'multi_select', 'iso')).toEqual({
      ok: true,
      value: ['A', 'B', 'C'],
      appendedOptions: ['A', 'B', 'C'],
    });
  });

  // Round-trip contract: the CSV export joins multi_select arrays with "; "
  // (export.routes.ts formatCustomFieldForCsv). Re-importing must split that
  // back into the same options, not one literal "A; B; C".
  it('round-trips the "A; B; C" multi_select export shape', () => {
    expect(coerceCustomFieldCell('A; B; C', 'multi_select', 'iso')).toEqual({
      ok: true,
      value: ['A', 'B', 'C'],
      appendedOptions: ['A', 'B', 'C'],
    });
  });

  it('normalizes url cells and warns on non-URLs', () => {
    expect(coerceCustomFieldCell('example.com/x', 'url', 'iso')).toEqual({
      ok: true,
      value: 'https://example.com/x',
    });
    expect(coerceCustomFieldCell('see Bob', 'url', 'iso')).toEqual({ ok: false, reason: 'not a URL' });
  });

  it('omits the key for empty cells (value undefined, never "")', () => {
    expect(coerceCustomFieldCell('', 'text', 'iso')).toEqual({ ok: true, value: undefined });
    expect(coerceCustomFieldCell('   ', 'number', 'iso')).toEqual({ ok: true, value: undefined });
  });
});

// ===========================================================================
// runImport — custom_field_mapping (find-or-create + coercion + warnings)
// ===========================================================================

// insert().values().onConflictDoNothing().returning() -> rows
function mockCustomFieldInsert(...rowsPerCall: unknown[][]) {
  let call = 0;
  mockDb.insert.mockImplementation(() => {
    const rows = rowsPerCall[call] ?? [];
    call++;
    const returning = vi.fn().mockResolvedValue(rows);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    return { values };
  });
}

// update().set().where() -> resolves (flushAppendedOptions)
function mockUpdateNoop() {
  mockDb.update.mockImplementation(() => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    return { set };
  });
}

describe('runImport with custom_field_mapping', () => {
  it('find-or-creates a custom field def, coerces cells, and passes custom_fields to createTask', async () => {
    // selects: getDefaultPhase, resolveCustomFieldDefs (no existing defs).
    queueSelect([{ id: PHASE_ID, is_start: true }], []);
    // insert: the new "QA Cost" number definition.
    mockCustomFieldInsert([
      { id: 'cf-1', name: 'QA Cost', field_type: 'number', options: null, position: 1 },
    ]);
    mockUpdateNoop();

    const body: ImportBody = {
      rows: [{ Feature: 'Build it', Cost: '$1,200' }],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: true },
      ],
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.imported).toBe(1);
    const input = createTaskMock.mock.calls[0]![1];
    expect(input.custom_fields).toEqual({ 'QA Cost': 1200 });
  });

  it('records a cell WARNING (not a row failure) for an uncoercible cell', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }], []);
    mockCustomFieldInsert([
      { id: 'cf-1', name: 'QA Cost', field_type: 'number', options: null, position: 1 },
    ]);
    mockUpdateNoop();

    const body: ImportBody = {
      rows: [{ Feature: 'Build it', Cost: '#N/A' }],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: true },
      ],
    };

    const result = await runImport(PROJECT_ID, body, REPORTER_ID);
    // Row still imported (warning, not failure).
    expect(result.imported).toBe(1);
    expect(result.cell_warnings).toEqual([
      { row: 1, column: 'Cost', value: '#N/A', reason: 'not a number' },
    ]);
    // The uncoercible key is omitted from custom_fields.
    const input = createTaskMock.mock.calls[0]![1];
    expect(input.custom_fields).toBeUndefined();
  });

  it('omits the custom field key for empty cells (never stores "")', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }], []);
    mockCustomFieldInsert([
      { id: 'cf-1', name: 'QA Cost', field_type: 'number', options: null, position: 1 },
    ]);
    mockUpdateNoop();

    const body: ImportBody = {
      rows: [{ Feature: 'Build it', Cost: '' }],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: true },
      ],
    };

    await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(createTaskMock.mock.calls[0]![1].custom_fields).toBeUndefined();
  });

  it('skips the column when create_if_missing is false and no definition exists', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }], []); // no existing defs
    mockCustomFieldInsert(); // should never be called
    mockUpdateNoop();

    const body: ImportBody = {
      rows: [{ Feature: 'Build it', Cost: '$1,200' }],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: false },
      ],
    };

    await runImport(PROJECT_ID, body, REPORTER_ID);
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(createTaskMock.mock.calls[0]![1].custom_fields).toBeUndefined();
  });

  it('appends unseen select options and flushes them to the definition', async () => {
    queueSelect([{ id: PHASE_ID, is_start: true }], []);
    mockCustomFieldInsert([
      { id: 'cf-1', name: 'Complexity', field_type: 'select', options: [], position: 1 },
    ]);
    mockUpdateNoop();

    const body: ImportBody = {
      rows: [
        { Feature: 'A', Cx: 'High' },
        { Feature: 'B', Cx: 'Low' },
        { Feature: 'C', Cx: 'High' },
      ],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cx', field_name: 'Complexity', field_type: 'select', create_if_missing: true },
      ],
    };

    await runImport(PROJECT_ID, body, REPORTER_ID);
    // The options update was flushed with the union of seen options.
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// previewImport — new_custom_fields + cell_warnings
// ===========================================================================

describe('previewImport custom fields', () => {
  it('reports new_custom_fields with inferred select options and cell_warnings', async () => {
    // selects: titleSet, phaseNames, labelNames, loadCustomFieldDefsForPreview.
    queueSelect([], [], [], []);

    const body: ImportBody = {
      rows: [
        { Feature: 'A', Cost: '$1,200', Cx: 'High' },
        { Feature: 'B', Cost: '#N/A', Cx: 'Low' },
      ],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: true },
        { column: 'Cx', field_name: 'Complexity', field_type: 'select', create_if_missing: true },
      ],
    };

    const result = await previewImport(PROJECT_ID, body, REPORTER_ID);

    // Two new defs reported, in mapping order.
    expect(result.new_custom_fields.map((f) => f.name)).toEqual(['QA Cost', 'Complexity']);
    const complexity = result.new_custom_fields.find((f) => f.name === 'Complexity')!;
    expect(complexity.field_type).toBe('select');
    expect(complexity.inferred_options).toEqual(['High', 'Low']);
    // The number-field also reports (no inferred_options for non-select types).
    const cost = result.new_custom_fields.find((f) => f.name === 'QA Cost')!;
    expect(cost.inferred_options).toBeUndefined();
    // #N/A surfaces as a cell warning (dry-run writes nothing).
    expect(result.cell_warnings).toEqual([
      { row: 2, column: 'Cost', value: '#N/A', reason: 'not a number' },
    ]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('omits a create_if_missing:false column from new_custom_fields when no def exists', async () => {
    queueSelect([], [], [], []); // no existing defs in preview loader
    const body: ImportBody = {
      rows: [{ Feature: 'A', Cost: '5' }],
      mapping: { title: 'Feature' },
      custom_field_mapping: [
        { column: 'Cost', field_name: 'QA Cost', field_type: 'number', create_if_missing: false },
      ],
    };
    const result = await previewImport(PROJECT_ID, body, REPORTER_ID);
    expect(result.new_custom_fields).toEqual([]);
  });
});
