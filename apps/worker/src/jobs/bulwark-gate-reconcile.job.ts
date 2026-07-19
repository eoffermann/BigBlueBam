/**
 * Bulwark gate-reconcile (Bulwark spec §6 / STJ3). Repeatable cron (every 20 min) + boot.
 *
 * A THIN caller (spec §9.2): it POSTs /v1/internal/gate-reconcile to bulwark-api, which rebuilds
 * every org's per-binding dispatch gate `bulwark:bindings:<org>` from the authoritative
 * bulwark_obligations table (the DISTINCT source/event_type of every armed obligation). The gate
 * is a CACHE, so a Redis flush cannot permanently drop triggers - this rebuild self-heals it.
 * bulwark-api also rebuilds at its own boot; this job is the ongoing cadence backstop.
 *
 * Idempotent (a full replace). Retry/backoff via BullMQ attempts.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { BulwarkSweepJobData } from '@bigbluebam/shared';
import { postBulwark } from './bulwark-shared.js';

export async function processBulwarkGateReconcileJob(
  job: Job<BulwarkSweepJobData>,
  logger: Logger,
): Promise<void> {
  const started = Date.now();
  const scope = job.data?.organization_id;
  logger.info({ jobId: job.id, scope }, 'bulwark-gate-reconcile: starting (POST /internal/gate-reconcile)');
  const res = await postBulwark('/internal/gate-reconcile', scope ? { organization_id: scope } : {}, 60_000);
  logger.info(
    { jobId: job.id, summary: res.data, elapsedMs: Date.now() - started },
    'bulwark-gate-reconcile: done',
  );
}
