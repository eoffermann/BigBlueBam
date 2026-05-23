import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
const { mockDb, mockQueueAdd } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };
  const mockQueueAdd: Record<string, ReturnType<typeof vi.fn>> = {};
  return { mockDb, mockQueueAdd };
});

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => {
    if (!mockQueueAdd[name]) {
      mockQueueAdd[name] = vi.fn().mockResolvedValue({ id: 'job-1' });
    }
    return { add: mockQueueAdd[name] };
  }),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/services/activity.service.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
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

// ---------- imports (after mocks) ----------
import { addProjectMember } from '../src/services/project.service.js';
import { logActivity } from '../src/services/activity.service.js';

// ---------- fixtures ----------
const PROJECT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID    = 'bbbbbbbb-0000-0000-0000-000000000001';
const ACTOR_ID   = 'cccccccc-0000-0000-0000-000000000001';
const MEMBERSHIP_ID = 'dddddddd-0000-0000-0000-000000000001';

const fakeMembership = {
  id: MEMBERSHIP_ID,
  project_id: PROJECT_ID,
  user_id: USER_ID,
  role: 'member',
  created_at: new Date(),
};

// ---------- helpers ----------
function setupInsert() {
  const returning = vi.fn().mockResolvedValue([fakeMembership]);
  const values = vi.fn().mockReturnValue({ returning });
  mockDb.insert.mockReturnValue({ values });
}

// Two selects fire in Promise.all: first for project name, second for actor name.
function setupSelects(projectName = 'Test Project', actorName = 'Actor User') {
  const makeSelect = (row: object) => {
    const limit = vi.fn().mockResolvedValue([row]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  };
  mockDb.select
    .mockReturnValueOnce(makeSelect({ name: projectName }))
    .mockReturnValueOnce(makeSelect({ name: actorName }));
}

// ---------- tests ----------
describe('project membership add → activity log + notifications queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls logActivity with member.added when actorId is provided', async () => {
    setupInsert();
    setupSelects();

    await addProjectMember(PROJECT_ID, USER_ID, 'member', ACTOR_ID);

    expect(vi.mocked(logActivity)).toHaveBeenCalledWith(
      PROJECT_ID,
      ACTOR_ID,
      'member.added',
      MEMBERSHIP_ID,
      expect.objectContaining({ user_id: USER_ID, role: 'member' }),
    );
  });

  it('enqueues a notifications job for the new member', async () => {
    setupInsert();
    setupSelects();

    await addProjectMember(PROJECT_ID, USER_ID, 'member', ACTOR_ID);

    await vi.waitFor(() => {
      expect(mockQueueAdd['notifications']).toBeDefined();
      expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          user_id: USER_ID,
          project_id: PROJECT_ID,
          type: 'project.member_added',
        }),
        expect.any(Object),
      );
    }, { timeout: 2000 });
  });

  it('notification has correct category and source_app', async () => {
    setupInsert();
    setupSelects();

    await addProjectMember(PROJECT_ID, USER_ID, 'member', ACTOR_ID);

    await vi.waitFor(() => {
      expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          category: 'membership_added',
          source_app: 'bbb',
        }),
        expect.any(Object),
      );
    }, { timeout: 2000 });
  });

  it('does not enqueue when no actorId is provided', async () => {
    setupInsert();

    await addProjectMember(PROJECT_ID, USER_ID, 'member');

    // Allow any pending microtasks to settle before asserting.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockQueueAdd['notifications']?.mock?.calls ?? []).toHaveLength(0);
    expect(vi.mocked(logActivity)).not.toHaveBeenCalled();
  });
});
