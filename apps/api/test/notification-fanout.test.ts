import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
const { mockQueueAdd } = vi.hoisted(() => {
  const mockQueueAdd: Record<string, ReturnType<typeof vi.fn>> = {};
  return { mockQueueAdd };
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

vi.mock('../src/env.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    NODE_ENV: 'test',
  },
}));

// ---------- import (after mocks) ----------
import { enqueueNotification } from '../src/services/notification-fanout.service.js';

// ---------- tests ----------
describe('enqueueNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues to the notifications queue', async () => {
    await enqueueNotification({
      user_id: 'user-1',
      project_id: 'proj-1',
      task_id: 'task-1',
      type: 'task.assigned',
      title: 'Task assigned: Fix login bug',
      body: 'Alice assigned you to "Fix login bug" in project Acme.',
      category: 'assignment',
      source_app: 'bbb',
      deep_link: '/b3/tasks/task-1',
    });

    expect(mockQueueAdd['notifications']).toHaveBeenCalledTimes(1);
  });

  it('job payload matches the data passed in', async () => {
    const data = {
      user_id: 'user-1',
      project_id: 'proj-1',
      task_id: 'task-1',
      type: 'task.assigned',
      title: 'Task assigned: Fix login bug',
      body: 'Alice assigned you to "Fix login bug" in project Acme.',
      category: 'assignment',
      source_app: 'bbb',
      deep_link: '/b3/tasks/task-1',
    };

    await enqueueNotification(data);

    expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
      expect.stringContaining('notif-user-1-'),
      expect.objectContaining(data),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('uses retry options with exponential backoff', async () => {
    await enqueueNotification({
      user_id: 'user-1',
      project_id: 'proj-1',
      type: 'task.assigned',
      title: 'Test',
      body: 'Test body',
    });

    expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      }),
    );
  });
});
