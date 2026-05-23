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
  // Capture add() calls keyed by queue name so we can assert per-queue.
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

vi.mock('../src/services/realtime.service.js', () => ({
  broadcastToProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/activity.service.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/slack-notify.service.js', () => ({
  postToSlack: vi.fn().mockResolvedValue(undefined),
  taskDeepLink: vi.fn().mockReturnValue('/b3/tasks/task-1'),
}));

vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../src/services/bolt-event-enricher.service.js', () => ({
  enrichTask: vi.fn(),
  loadActor: vi.fn(),
  loadOrg: vi.fn(),
  loadPhase: vi.fn().mockResolvedValue(null),
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
import { updateTask } from '../src/services/task.service.js';
import { enrichTask, loadActor, loadOrg } from '../src/services/bolt-event-enricher.service.js';
import { publishBoltEvent } from '../src/lib/bolt-events.js';

// ---------- fixtures ----------
const now = new Date();
const TASK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PROJECT_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const ACTOR_ID = 'cccccccc-0000-0000-0000-000000000001';
const ASSIGNEE_ID = 'dddddddd-0000-0000-0000-000000000001';
const ORG_ID = 'eeeeeeee-0000-0000-0000-000000000001';

const fakeTask = {
  id: TASK_ID,
  project_id: PROJECT_ID,
  human_id: 'TST-1',
  parent_task_id: null,
  title: 'Fix the login bug',
  description: null,
  phase_id: 'phase-1',
  state_id: 'state-1',
  sprint_id: null,
  epic_id: null,
  assignee_id: ASSIGNEE_ID,
  reporter_id: ACTOR_ID,
  priority: 'medium',
  story_points: null,
  time_estimate_minutes: null,
  start_date: null,
  due_date: null,
  completed_at: null,
  labels: [],
  custom_fields: {},
  subtask_count: 0,
  position: 1024,
  created_at: now,
  updated_at: now,
};

// ---------- helpers ----------
function setupTaskUpdate(taskOverrides: Partial<typeof fakeTask> = {}) {
  const returning = vi.fn().mockResolvedValue([{ ...fakeTask, ...taskOverrides }]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValue({ set });
}

function setupOrgSelect() {
  const limit = vi.fn().mockResolvedValue([{ org_id: ORG_ID }]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValue({ from });
}

function setupEnrichers(assignee: object | null = {
  id: ASSIGNEE_ID,
  email: 'assignee@example.com',
  name: 'Assignee User',
}) {
  vi.mocked(enrichTask).mockResolvedValue({
    task: fakeTask,
    project: { id: PROJECT_ID, name: 'Test Project' },
    phase: null,
    sprint: null,
    epic: null,
    assignee,
    reporter: null,
  } as any);
  vi.mocked(loadActor).mockResolvedValue({ id: ACTOR_ID, name: 'Actor User' } as any);
  vi.mocked(loadOrg).mockResolvedValue({ id: ORG_ID, name: 'Test Org' } as any);
}

// Wait for the fire-and-forget Bolt block to complete.
// publishBoltEvent is called synchronously inside it, so once it's been
// called we know all the code in the .then() callback has run.
async function waitForBoltBlock() {
  await vi.waitFor(() => {
    expect(vi.mocked(publishBoltEvent)).toHaveBeenCalled();
  }, { timeout: 2000 });
}

// ---------- tests ----------
describe('task assignment → notifications queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a job to the notifications queue when assignee_id changes', async () => {
    setupTaskUpdate({ assignee_id: ASSIGNEE_ID });
    setupOrgSelect();
    setupEnrichers();

    await updateTask(TASK_ID, { assignee_id: ASSIGNEE_ID }, ACTOR_ID);

    await vi.waitFor(() => {
      expect(mockQueueAdd['notifications']).toBeDefined();
      expect(mockQueueAdd['notifications']).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('notification job payload includes user_id, task_id, project_id, type, category, and source_app', async () => {
    setupTaskUpdate({ assignee_id: ASSIGNEE_ID });
    setupOrgSelect();
    setupEnrichers();

    await updateTask(TASK_ID, { assignee_id: ASSIGNEE_ID }, ACTOR_ID);

    await vi.waitFor(() => {
      expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          user_id: ASSIGNEE_ID,
          task_id: TASK_ID,
          project_id: PROJECT_ID,
          type: 'task.assigned',
          category: 'assignment',
          source_app: 'bbb',
        }),
        expect.any(Object),
      );
    }, { timeout: 2000 });
  });

  it('does not enqueue when no assignee_id in the update', async () => {
    setupTaskUpdate();
    setupOrgSelect();
    setupEnrichers();

    await updateTask(TASK_ID, { title: 'Renamed task' }, ACTOR_ID);
    await waitForBoltBlock();

    expect(mockQueueAdd['notifications']?.mock?.calls ?? []).toHaveLength(0);
  });

  it('does not enqueue when actor is the new assignee (self-assignment)', async () => {
    setupTaskUpdate({ assignee_id: ACTOR_ID });
    setupOrgSelect();
    setupEnrichers({ id: ACTOR_ID, email: 'actor@example.com', name: 'Actor User' });

    await updateTask(TASK_ID, { assignee_id: ACTOR_ID }, ACTOR_ID);
    await waitForBoltBlock();

    expect(mockQueueAdd['notifications']?.mock?.calls ?? []).toHaveLength(0);
  });
});
