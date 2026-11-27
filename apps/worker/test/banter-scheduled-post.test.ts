// §13 Wave 4 scheduled banter — unit tests for the scheduled-post worker
// job. Mocks db + bolt-events + the Redis publish channel.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type Redis from 'ioredis';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../src/utils/bolt-events.js', () => ({
  publishBoltEvent: vi.fn(),
}));

import {
  processBanterScheduledPostJob,
  reconcileScheduledPosts,
  type BanterScheduledPostJobData,
} from '../src/jobs/banter-scheduled-post.job.js';
import { getDb } from '../src/utils/db.js';
import { publishBoltEvent } from '../src/utils/bolt-events.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeJob(id: string): Job<BanterScheduledPostJobData> {
  return {
    id: `bullmq:${id}`,
    data: { scheduled_message_id: id },
    name: 'scheduled-post',
  } as unknown as Job<BanterScheduledPostJobData>;
}

function makeRedis(): Redis {
  return {
    publish: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

const SCHEDULED_ROW = {
  id: 'sched-1',
  org_id: 'org-1',
  channel_id: 'chan-1',
  author_id: 'user-1',
  content: 'hello from the past',
  content_format: 'html',
  thread_parent_id: null,
  metadata: {},
  status: 'pending',
  scheduled_at: new Date('2026-04-16T09:00:00Z'),
};

describe('processBanterScheduledPostJob — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers the message, flips row to delivered, emits Bolt event', async () => {
    const execute = vi.fn()
      // 1. SELECT scheduled row
      .mockResolvedValueOnce([SCHEDULED_ROW])
      // 2. SELECT membership / user / channel — author is member
      .mockResolvedValueOnce([
        {
          channel_role: 'member',
          user_role: 'member',
          is_superuser: false,
          user_org_id: 'org-1',
          channel_org_id: 'org-1',
        },
      ])
      // 3. INSERT into banter_messages → { id, created_at }
      .mockResolvedValueOnce([
        { id: 'new-msg-1', created_at: new Date('2026-04-16T09:00:00Z') },
      ])
      // 4. UPDATE banter_channels counters
      .mockResolvedValueOnce([])
      // 5. UPDATE banter_scheduled_messages → delivered
      .mockResolvedValueOnce([]);

    vi.mocked(getDb).mockReturnValue({ execute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    const redis = makeRedis();
    await processBanterScheduledPostJob(makeJob('sched-1'), redis, mockLogger);

    expect(execute).toHaveBeenCalled();
    expect(publishBoltEvent).toHaveBeenCalledWith(
      'message.scheduled_delivered',
      'banter',
      expect.objectContaining({
        scheduled_message_id: 'sched-1',
        message_id: 'new-msg-1',
        channel_id: 'chan-1',
      }),
      'org-1',
      'user-1',
      'user',
    );
    expect((redis.publish as any)).toHaveBeenCalledWith(
      'banter:events',
      expect.stringContaining('message.created'),
    );
  });
});

describe('processBanterScheduledPostJob — thread parent deleted (#368)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the row failed instead of retrying when the reference trigger answers 23503', async () => {
    const fk = Object.assign(new Error('violates the banter_messages reference on "thread_parent_id"'), {
      code: '23503',
    });
    const execute = vi.fn()
      .mockResolvedValueOnce([{ ...SCHEDULED_ROW, thread_parent_id: 'gone-parent' }])
      .mockResolvedValueOnce([
        { channel_role: 'member', user_role: 'member', is_superuser: false, user_org_id: 'org-1', channel_org_id: 'org-1' },
      ])
      .mockRejectedValueOnce(fk)
      .mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue({ execute } as any);

    await expect(processBanterScheduledPostJob(makeJob('sched-1'), makeRedis(), mockLogger)).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(execute.mock.calls[3]![0])).toContain('thread_parent_deleted');
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });
});

describe('processBanterScheduledPostJob — membership revoked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks the row failed with defer_reason=membership_revoked', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([SCHEDULED_ROW])
      // Author has no channel membership and is not org staff
      .mockResolvedValueOnce([
        {
          channel_role: null,
          user_role: 'member',
          is_superuser: false,
          user_org_id: 'org-1',
          channel_org_id: 'org-1',
        },
      ])
      // Failed-update statement
      .mockResolvedValueOnce([]);

    vi.mocked(getDb).mockReturnValue({ execute } as any);

    const redis = makeRedis();
    await processBanterScheduledPostJob(makeJob('sched-1'), redis, mockLogger);

    expect(publishBoltEvent).not.toHaveBeenCalled();
    // Third execute() call is the UPDATE ... SET status='failed'
    expect(execute).toHaveBeenCalledTimes(3);
  });
});

describe('processBanterScheduledPostJob — skip cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a no-op when the row is not pending', async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      { ...SCHEDULED_ROW, status: 'delivered' },
    ]);
    vi.mocked(getDb).mockReturnValue({ execute } as any);
    const redis = makeRedis();
    await processBanterScheduledPostJob(makeJob('sched-1'), redis, mockLogger);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });

  it('returns a no-op when the row does not exist', async () => {
    const execute = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue({ execute } as any);
    const redis = makeRedis();
    await processBanterScheduledPostJob(makeJob('nope'), redis, mockLogger);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(publishBoltEvent).not.toHaveBeenCalled();
  });
});

describe('reconcileScheduledPosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-enqueues every pending row in the window', async () => {
    const now = Date.now();
    const rows = [
      { id: 'sched-a', scheduled_at: new Date(now + 60_000) },
      { id: 'sched-b', scheduled_at: new Date(now + 3600_000) },
    ];
    const execute = vi.fn().mockResolvedValueOnce(rows);
    vi.mocked(getDb).mockReturnValue({ execute } as any);

    const queueAdd = vi.fn().mockResolvedValue(undefined);
    const count = await reconcileScheduledPosts(queueAdd, mockLogger);

    expect(count).toBe(2);
    expect(queueAdd).toHaveBeenCalledWith(
      'banter-scheduled-post:sched-a',
      { scheduled_message_id: 'sched-a' },
      expect.any(Number),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'banter-scheduled-post:sched-b',
      { scheduled_message_id: 'sched-b' },
      expect.any(Number),
    );
  });

  it('continues even if one enqueue fails', async () => {
    const now = Date.now();
    const rows = [
      { id: 'sched-ok', scheduled_at: new Date(now + 60_000) },
      { id: 'sched-bad', scheduled_at: new Date(now + 3600_000) },
    ];
    const execute = vi.fn().mockResolvedValueOnce(rows);
    vi.mocked(getDb).mockReturnValue({ execute } as any);

    const queueAdd = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'));
    const count = await reconcileScheduledPosts(queueAdd, mockLogger);

    expect(count).toBe(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
