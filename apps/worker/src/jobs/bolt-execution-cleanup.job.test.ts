import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

// postgres-js's prepared-statement bind layer expects each parameter to
// be a string, Buffer, or ArrayBuffer. Passing a JS Date directly trips
// `ERR_INVALID_ARG_TYPE` in node:buffer.byteLength before the request
// even leaves the client. The cleanup job ran into this on its
// `WHERE created_at < ${cutoff}` template — fixed by converting to
// `cutoff.toISOString()` first.
//
// This test pins that no Date object is passed as a sql binding. We
// stub the `execute` call and inspect the drizzle SqlQuery the
// processor builds.

vi.mock('../utils/db.js', () => ({
  getDb: () => ({
    execute: vi.fn(async (q: unknown) => {
      // drizzle SqlQuery exposes the bound params on .params after
      // toQuery(); the shape we get here depends on the version. The
      // test does a structural sweep: any Date object reachable in
      // the bound params (one nested level deep) means the regression
      // is back.
      const params = (q as { queryChunks?: unknown[]; params?: unknown[] }).params
        ?? (q as { queryChunks?: unknown[] }).queryChunks
        ?? [];
      for (const p of params as unknown[]) {
        if (p instanceof Date) {
          throw new Error('Regression: Date object reached the SQL bind layer');
        }
        if (p && typeof p === 'object' && 'value' in (p as Record<string, unknown>)) {
          const inner = (p as { value: unknown }).value;
          if (inner instanceof Date) {
            throw new Error('Regression: Date object reached the SQL bind layer');
          }
        }
      }
      return [];
    }),
  }),
}));

const { processBoltExecutionCleanupJob } = await import('./bolt-execution-cleanup.job.js');

function fakeLogger(): Logger {
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
  return { id: 'cleanup-job', data } as unknown as Job;
}

describe('processBoltExecutionCleanupJob', () => {
  it('passes the cutoff as an ISO string, not a Date, to the SQL bindings', async () => {
    await expect(
      processBoltExecutionCleanupJob(
        fakeJob({ retention_days: 7 }) as never,
        fakeLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it('falls back to 90 days when retention_days is missing', async () => {
    await expect(
      processBoltExecutionCleanupJob(
        fakeJob({}) as never,
        fakeLogger(),
      ),
    ).resolves.toBeUndefined();
  });

  it('falls back to 90 days when retention_days is invalid', async () => {
    await expect(
      processBoltExecutionCleanupJob(
        fakeJob({ retention_days: -5 }) as never,
        fakeLogger(),
      ),
    ).resolves.toBeUndefined();
  });
});
