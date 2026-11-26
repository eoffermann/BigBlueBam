/**
 * bastion-evaluate-run (Bastion spec 7, 7.1, 7.3). Event-driven: bastion-api enqueues it when a
 * run is created, and bastion-evaluate-tick re-enqueues claimed nightly runs, resumed partial
 * runs and orphaned queued runs. Drives the run with the bursar-level loop: one engine call per
 * slice (bastion-api stops starting probes at 12 s), polling every 10 s, at most MAX_POLLS (540 x
 * 10 s = 90 minutes); if the run is still live after that the job re-enqueues itself under a new
 * jobId and ends. Slices skip assertions already snapshotted, so any re-drive is idempotent.
 *
 *   200 done        the run finished (succeeded or partial with a reason); end.
 *   200 not done    more to do, or waiting on storage / the ledger lock; poll again.
 *   404             the run is gone; end.
 *   409 stale       another claimant's heartbeat is stale: wait 30 s and retry (spec 7),
 *                   because that claim will be taken over at the lease, not abandoned.
 *   409 live        another worker is driving it; end this attempt.
 *
 * Progress: one line per slice with the counts bastion-api also writes on the run row.
 */
import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { bastionEvaluateRunJobId, type BastionEvaluateRunJobData } from '@bigbluebam/shared';
import { SCHEDULED_JOB_RETENTION } from '../lib/job-retention.js';
import { bodyData, postBastion } from './bastion-shared.js';

export const EVALUATE_POLL_INTERVAL_MS = 10_000;
export const EVALUATE_MAX_POLLS = 540;
export const STALE_CLAIM_WAIT_MS = 30_000;

interface Slice {
  done: boolean;
  status: string;
  partial_reason?: string | null;
  assertions_done: number;
  assertions_total: number;
  controls_done: number;
  controls_total: number;
  pass: number;
  fail: number;
  unprovable: number;
  slice_ms: number;
  waiting?: string;
}

export interface EvaluateRunDeps {
  post: typeof postBastion;
  sleep?: (ms: number) => Promise<void>;
  /** The evaluate-run queue, for the self re-enqueue after MAX_POLLS. */
  queue: Pick<Queue<BastionEvaluateRunJobData>, 'add'>;
  maxPolls?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function processBastionEvaluateRunJob(
  job: Job<BastionEvaluateRunJobData>,
  logger: Logger,
  deps: EvaluateRunDeps,
): Promise<'done' | 'ended' | 'requeued'> {
  const { organization_id, run_id, resume_count } = job.data;
  const claimant = `worker:${job.id ?? run_id}`;
  const started = Date.now();
  const sleep = deps.sleep ?? realSleep;
  const maxPolls = deps.maxPolls ?? EVALUATE_MAX_POLLS;
  logger.info({ jobId: job.id, organization_id, run_id, resume_count }, 'bastion-evaluate: starting run');

  for (let poll = 0; poll < maxPolls; poll++) {
    const res = await deps.post('/v1/internal/engines/evaluate-run', { organization_id, run_id, claimant });
    if (res.status === 404) {
      logger.warn({ run_id }, 'bastion-evaluate: run not found; ending');
      return 'ended';
    }
    if (res.status === 409) {
      const stale = (res.data as { error?: { heartbeat_stale?: boolean } } | undefined)?.error?.heartbeat_stale === true;
      if (stale) {
        logger.info({ run_id }, 'bastion-evaluate: another claim has a stale heartbeat; waiting 30 s before retrying');
        await sleep(STALE_CLAIM_WAIT_MS);
        continue;
      }
      logger.info({ run_id }, 'bastion-evaluate: run is being driven by another worker; ending this attempt');
      return 'ended';
    }
    if (!res.ok) throw new Error(`bastion-evaluate: evaluate-run returned ${res.status}`);
    const s = bodyData<Slice>(res);
    if (s) {
      logger.info(
        { run_id, poll, status: s.status, waiting: s.waiting, partial_reason: s.partial_reason },
        `bastion-evaluate: run ${run_id} controls ${s.controls_done}/${s.controls_total} assertions ${s.assertions_done}/${s.assertions_total} (pass ${s.pass}, fail ${s.fail}, unprovable ${s.unprovable}) slice_ms=${s.slice_ms} elapsed_ms=${Date.now() - started} resume=${resume_count}`,
      );
      if (s.done) return 'done';
      // A full slice returns immediately for the next one; a waiting slice backs off.
      if (s.waiting) await sleep(EVALUATE_POLL_INTERVAL_MS);
    } else {
      await sleep(EVALUATE_POLL_INTERVAL_MS);
    }
  }

  // Still live after the poll cap: hand over to a fresh job (a new jobId, never deduplicated).
  const generation = Math.floor(Date.now() / 1000);
  await deps.queue.add('run', job.data, {
    jobId: bastionEvaluateRunJobId(run_id, resume_count, generation),
    ...SCHEDULED_JOB_RETENTION,
  });
  logger.info({ run_id, elapsed_ms: Date.now() - started }, 'bastion-evaluate: poll cap reached; re-enqueued under a new job id');
  return 'requeued';
}
