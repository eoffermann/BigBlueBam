import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
// Mirror apps/api/test/notification-fanout.test.ts: stub bullmq + ioredis so
// the producer never touches a live Redis, and capture the `.add(...)` calls.
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
import { enqueueBureauNotification } from '../src/services/notify.service.js';

// ---------- tests ----------
describe('enqueueBureauNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a bureau knock notification to the shared notifications queue', async () => {
    await enqueueBureauNotification({
      user_id: 'owner-1',
      org_id: 'org-1',
      type: 'bureau.knock',
      category: 'knock',
      source_app: 'bureau',
      title: 'Alice knocked',
      body: 'Alice knocked on your office "Corner Office"',
      deep_link: '/bureau/',
    });

    expect(mockQueueAdd['notifications']).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
      expect.stringContaining('notif-owner-1-'),
      expect.objectContaining({
        user_id: 'owner-1',
        source_app: 'bureau',
        category: 'knock',
        type: 'bureau.knock',
        deep_link: '/bureau/',
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      }),
    );
  });

  it('enqueues a bureau summon notification with the invite category', async () => {
    await enqueueBureauNotification({
      user_id: 'recipient-1',
      org_id: 'org-1',
      type: 'bureau.summon',
      category: 'invite',
      source_app: 'bureau',
      title: 'Bob invited you to Whiteboard',
      body: 'Bob summoned you to Whiteboard. Join them in Bureau.',
      deep_link: '/bureau/',
    });

    expect(mockQueueAdd['notifications']).toHaveBeenCalledWith(
      expect.stringContaining('notif-recipient-1-'),
      expect.objectContaining({
        type: 'bureau.summon',
        category: 'invite',
        source_app: 'bureau',
      }),
      expect.anything(),
    );
  });

  it('is fire-and-forget: swallows enqueue errors and never throws', async () => {
    mockQueueAdd['notifications'].mockRejectedValueOnce(new Error('redis down'));
    const warn = vi.fn();

    await expect(
      enqueueBureauNotification(
        {
          user_id: 'owner-1',
          org_id: 'org-1',
          type: 'bureau.knock',
          title: 'Alice knocked',
          body: 'Alice knocked',
        },
        { warn },
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
