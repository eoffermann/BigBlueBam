/**
 * Bulwark fire-on-event drain (Bulwark spec §4.2). Event-driven queue consumer.
 *
 * A THIN caller (spec §9.2): enqueued by bulwark-api's /internal/events inbox write with
 * { org_id, ingest_event_id }, it POSTs /v1/internal/drain-event to bulwark-api, which loads the
 * durably-inboxed event, matches it against armed obligations, evaluates each entity_filter
 * FAIL-CLOSED (S5), computes the timezone-anchored due_at, and arms at-most-once via the
 * deterministic event arm key. The drain lives in bulwark-api's firing service; this job invokes
 * it (the brief). A lost enqueue is separately recovered by the radar pending-inbox drain (STJ2).
 *
 * Idempotent: re-draining is a no-op (the deterministic arm key + ON CONFLICT DO NOTHING).
 * Bounded retry + exponential backoff via BullMQ attempts; on final give-up the failed handler
 * DLQs to a log (the pending-inbox drain re-processes the still-pending row).
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BulwarkFireOnEventJobData } from '@bigbluebam/shared';
import { postBulwark } from './bulwark-shared.js';

export async function processBulwarkFireOnEventJob(
  job: Job<BulwarkFireOnEventJobData>,
  logger: Logger,
): Promise<void> {
  const { org_id, ingest_event_id } = job.data;
  const started = Date.now();
  logger.info(
    { jobId: job.id, org_id, ingest_event_id, attempt: job.attemptsMade + 1 },
    'bulwark-fire-on-event: starting (POST /internal/drain-event)',
  );
  const res = await postBulwark('/internal/drain-event', { org_id, ingest_event_id });
  logger.info(
    { jobId: job.id, org_id, ingest_event_id, result: res.data, elapsedMs: Date.now() - started },
    'bulwark-fire-on-event: done',
  );
}

// DLQ give-up (best-effort log; the radar pending-inbox drain re-processes the still-pending row).
export function bulwarkFireOnEventDlq(data: BulwarkFireOnEventJobData, logger: Logger): void {
  logger.warn(
    { org_id: data.org_id, ingest_event_id: data.ingest_event_id },
    'bulwark-fire-on-event: DLQ give-up; radar pending-inbox drain will re-process the pending row',
  );
}
