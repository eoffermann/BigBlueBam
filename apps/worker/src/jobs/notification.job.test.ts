import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

// processNotificationJob has historically failed in two ways:
//
//   1. Beacon (and similar satellite-app) call sites enqueued jobs with
//      missing user_id/title/body. drizzle's sql tag interpolated
//      undefined as nothing, postgres then reported "syntax error at
//      or near ','" — a confusing message because the syntax error was
//      literally a comma with no value between it and the next comma.
//   2. source_app values outside ('bbb','banter','helpdesk') tripped
//      the CHECK constraint added by migration 0019. Migration 0185
//      widens the constraint; the processor needs to actually pass
//      the satellite app value through.
//
// The tests below pin both behaviors so a regression on either side
// can't escape CI.

vi.mock('../utils/db.js', () => ({
  getDb: () => ({
    execute: vi.fn(async () => []),
  }),
}));

// The realtime push is fire-and-forget and opens a real Redis socket. Stub it
// so these input-validation tests don't depend on (or hang waiting for) Redis.
vi.mock('../lib/realtime-publish.js', () => ({
  publishToUser: vi.fn(),
}));

const { processNotificationJob } = await import('./notification.job.js');

function fakeLogger(): Logger {
  // Pino's interface is broad; we only call info/warn from the
  // processor and we don't need to assert on log lines.
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

function fakeJob(data: Record<string, unknown>): Job {
  return { id: 'test-job', data } as unknown as Job;
}

describe('processNotificationJob — input validation', () => {
  it('throws a clear error when user_id is missing (was: postgres 42601)', async () => {
    await expect(
      processNotificationJob(
        fakeJob({
          // user_id deliberately omitted
          type: 'beacon.pending_review',
          title: 'Beacon needs review',
          body: 'a beacon you own has reached its review window',
          source_app: 'beacon',
        }) as never,
        fakeLogger(),
      ),
    ).rejects.toThrow(/user_id=MISSING/);
  });

  it('throws when title is missing', async () => {
    await expect(
      processNotificationJob(
        fakeJob({
          user_id: '00000000-0000-0000-0000-000000000001',
          type: 'beacon.pending_review',
          // title omitted
          body: 'body present',
        }) as never,
        fakeLogger(),
      ),
    ).rejects.toThrow(/title=MISSING/);
  });

  it('throws when body is missing', async () => {
    await expect(
      processNotificationJob(
        fakeJob({
          user_id: '00000000-0000-0000-0000-000000000001',
          type: 'beacon.pending_review',
          title: 'present',
          // body omitted
        }) as never,
        fakeLogger(),
      ),
    ).rejects.toThrow(/body=MISSING/);
  });

  it('accepts a full satellite-app job (source_app: beacon, null project)', async () => {
    // Migration 0185 lets project_id be null and adds 'beacon' to the
    // source_app check — the processor must pass them through cleanly
    // for satellite-app notifications to land.
    await expect(
      processNotificationJob(
        fakeJob({
          user_id: '00000000-0000-0000-0000-000000000001',
          project_id: null,
          org_id: '00000000-0000-0000-0000-000000000002',
          type: 'beacon.pending_review',
          title: 'Beacon needs review',
          body: 'a beacon you own has reached its review window',
          category: 'lifecycle',
          source_app: 'beacon',
          deep_link: '/beacon/entries/abc',
          metadata: { beacon_id: 'abc' },
        }) as never,
        fakeLogger(),
      ),
    ).resolves.toBeUndefined();
  });
});
