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
    INTERNAL_SERVICE_SECRET: 's'.repeat(40),
    BANTER_API_URL: 'http://banter-api.railway.internal:8080',
  },
}));

// ---------- import (after mocks) ----------
import { enqueueNotification, fanoutNotification } from '../src/services/notification-fanout.service.js';

// #278: the Banter DM must match banter-api's POST /v1/internal/dm contract and guard.
describe('fanoutNotification banter_dm', () => {
  const base = {
    recipient_user_id: '00000000-0000-4000-8000-0000000000b1',
    subject: 'Task assigned: Fix the radio',
    body: 'Gilligan assigned you to "Fix the radio".',
    url: '/b3/tasks/t1',
    org_id: '00000000-0000-4000-8000-0000000000a1',
  };

  it('sends the route body from the acting user with the shared internal secret', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 201 }));
    const [result] = await fanoutNotification({ ...base, actor_user_id: '00000000-0000-4000-8000-0000000000c1' }, ['banter_dm']);
    expect(result).toEqual({ channel: 'banter_dm', status: 'sent' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    // #303: the base comes from env.BANTER_API_URL, not a hard-coded compose default.
    expect(String(url)).toBe('http://banter-api.railway.internal:8080/v1/internal/dm');
    expect((init!.headers as Record<string, string>)['X-Internal-Secret']).toBe('s'.repeat(40));
    const body = JSON.parse(String(init!.body));
    // Exactly the fields banter's zod schema reads: org_id, from_user_id, to_user_id, content, source.
    expect(Object.keys(body).sort()).toEqual(['content', 'from_user_id', 'org_id', 'source', 'to_user_id']);
    expect(body).toMatchObject({
      org_id: base.org_id,
      from_user_id: '00000000-0000-4000-8000-0000000000c1',
      to_user_id: base.recipient_user_id,
    });
    expect(body.content).toContain('Task assigned: Fix the radio');
    fetchSpy.mockRestore();
  });

  it('skips (no request) when there is no sending user, or the sender is the recipient', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const [noActor] = await fanoutNotification(base, ['banter_dm']);
    const [self] = await fanoutNotification({ ...base, actor_user_id: base.recipient_user_id }, ['banter_dm']);
    expect(noActor!.status).toBe('skipped');
    expect(self!.status).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

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
