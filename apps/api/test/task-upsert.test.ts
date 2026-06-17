import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup mirrors apps/api/test/task.test.ts so the database chain is
// consistent with the rest of the suite. See task.test.ts for rationale.
// ---------------------------------------------------------------------------

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/services/realtime.service.js', () => ({
  broadcastToProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/activity.service.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/bolt-event-enricher.service.js', () => ({
  enrichTask: vi.fn().mockResolvedValue({
    task: { id: 'task-1' },
    project: null,
    phase: null,
    sprint: null,
    epic: null,
    assignee: null,
    reporter: null,
  }),
  loadActor: vi.fn().mockResolvedValue(null),
  loadOrg: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

import {
  upsertTaskByExternalId,
  TaskUpsertError,
} from '../src/services/task-upsert.service.js';

// ---------------------------------------------------------------------------
// Chain helpers
// ---------------------------------------------------------------------------

function mockExistingRow(row: unknown | null) {
  const limitFn = vi.fn().mockResolvedValue(row ? [row] : []);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn, orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn });
  mockDb.select.mockReturnValueOnce({ from: fromFn });
}

function mockFirstPhase(phase: { id: string; auto_state_on_enter: string | null } | null) {
  const limitFn = vi.fn().mockResolvedValue(phase ? [phase] : []);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn, limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValueOnce({ from: fromFn });
}

function mockPositionQuery(maxPos: number) {
  const whereFn = vi.fn().mockResolvedValue([{ maxPos }]);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValueOnce({ from: fromFn });
}

// Insert path resolves the project's org_id (tasks.org_id backfill fix) via
// select projects.org_id between the first-phase fallback and the position query.
function mockProjectOrg(orgId: string | null) {
  const limitFn = vi.fn().mockResolvedValue(orgId ? [{ org_id: orgId }] : [{}]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValueOnce({ from: fromFn });
}

function mockProjectSequenceUpdate(prefix: string, seq: number) {
  const returningFn = vi.fn().mockResolvedValue([
    { task_id_prefix: prefix, task_id_sequence: seq },
  ]);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValueOnce({ set: setFn });
}

function mockInsertUpsertReturning(task: Record<string, unknown>, created: boolean) {
  const returningFn = vi.fn().mockResolvedValue([{ task, created }]);
  const onConflictFn = vi.fn().mockReturnValue({ returning: returningFn });
  const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictFn });
  mockDb.insert.mockReturnValueOnce({ values: valuesFn });
}

function mockStraightUpdateReturning(task: Record<string, unknown>) {
  const returningFn = vi.fn().mockResolvedValue([task]);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValueOnce({ set: setFn });
}

const now = new Date();
function fakeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    human_id: 'TST-1',
    external_id: 'ext-1',
    title: 'From webhook',
    description: null,
    phase_id: 'phase-1',
    state_id: null,
    sprint_id: null,
    epic_id: null,
    assignee_id: null,
    reporter_id: 'user-1',
    priority: 'medium',
    story_points: null,
    time_estimate_minutes: null,
    start_date: null,
    due_date: null,
    completed_at: null,
    position: 1024,
    labels: [],
    watchers: [],
    is_blocked: false,
    blocking_task_ids: [],
    blocked_by_task_ids: [],
    custom_fields: {},
    attachment_count: 0,
    comment_count: 0,
    subtask_count: 0,
    subtask_done_count: 0,
    carry_forward_count: 0,
    original_sprint_id: null,
    parent_task_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// upsertTaskByExternalId — validation
// ---------------------------------------------------------------------------

describe('upsertTaskByExternalId — validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects empty external_id', async () => {
    await expect(
      upsertTaskByExternalId(
        { project_id: 'proj-1', external_id: '', title: 't' },
        'user-1',
      ),
    ).rejects.toThrow(TaskUpsertError);
  });

  it('rejects empty title', async () => {
    await expect(
      upsertTaskByExternalId(
        { project_id: 'proj-1', external_id: 'e-1', title: '   ' },
        'user-1',
      ),
    ).rejects.toThrow(/title/);
  });
});

// ---------------------------------------------------------------------------
// upsertTaskByExternalId — create path
// ---------------------------------------------------------------------------

describe('upsertTaskByExternalId — create path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns created=true when inserting a new row', async () => {
    // Pre-check: no existing row.
    mockExistingRow(null);
    // First-phase fallback.
    mockFirstPhase({ id: 'phase-1', auto_state_on_enter: null });
    // Project org lookup (tasks.org_id).
    mockProjectOrg('org-1');
    // Position query.
    mockPositionQuery(0);
    // Project sequence update.
    mockProjectSequenceUpdate('TST', 1);
    // Insert with ON CONFLICT returning.
    mockInsertUpsertReturning(fakeTask({ external_id: 'ext-1' }), true);

    const result = await upsertTaskByExternalId(
      { project_id: 'proj-1', external_id: 'ext-1', title: 'From webhook' },
      'user-1',
    );

    expect(result.created).toBe(true);
    expect(result.data.external_id).toBe('ext-1');
    expect(result.idempotency_key).toBe('external_id:proj-1:ext-1');
  });

  it('returns created=false if the insert was raced and conflicted', async () => {
    mockExistingRow(null);
    mockFirstPhase({ id: 'phase-1', auto_state_on_enter: null });
    mockProjectOrg('org-1');
    mockPositionQuery(0);
    mockProjectSequenceUpdate('TST', 1);
    // xmax != 0 → ON CONFLICT branch fired.
    mockInsertUpsertReturning(fakeTask({ external_id: 'ext-1' }), false);

    const result = await upsertTaskByExternalId(
      { project_id: 'proj-1', external_id: 'ext-1', title: 'From webhook' },
      'user-1',
    );

    expect(result.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertTaskByExternalId — update path
// ---------------------------------------------------------------------------

describe('upsertTaskByExternalId — update path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns created=false and patches the existing row', async () => {
    const existing = fakeTask({ external_id: 'ext-1', title: 'Old' });
    mockExistingRow(existing);
    mockStraightUpdateReturning({ ...existing, title: 'New title' });

    const result = await upsertTaskByExternalId(
      { project_id: 'proj-1', external_id: 'ext-1', title: 'New title' },
      'user-1',
    );

    expect(result.created).toBe(false);
    expect(result.data.title).toBe('New title');
    expect(result.idempotency_key).toBe('external_id:proj-1:ext-1');
  });
});
