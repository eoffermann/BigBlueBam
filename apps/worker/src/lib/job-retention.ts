import type { JobsOptions } from 'bullmq';

/**
 * Bounded history for jobs created by a job scheduler (upsertJobScheduler).
 *
 * Without removeOnComplete/removeOnFail BullMQ keeps every finished job record
 * forever. A 15 s ticker alone leaves ~5,800 records a day, and on 2026-10-25 a
 * five-day-old local stack filled Redis's 256 MB (noeviction), which turned
 * logins into 500s. Keep the last 100 completed and 500 failed runs per queue,
 * enough to debug a recent failure without unbounded growth.
 */
export const SCHEDULED_JOB_RETENTION = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} satisfies JobsOptions;

/** Add the retention policy to a job scheduler's job template. */
export function withRetention<T extends { name?: string; data?: unknown; opts?: JobsOptions }>(
  template: T,
): T & { opts: JobsOptions } {
  return { ...template, opts: { ...SCHEDULED_JOB_RETENTION, ...template.opts } };
}
