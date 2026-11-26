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
 *   5xx / timeout   transient (bastion-api restarting, the engine call outran its 30 s bound):
 *                   wait and poll again under the SAME claimant, which bastion-api lets re-claim
 *                   at once; after TRANSIENT_MAX_CONSECUTIVE in a row the job throws.
 *
 * Claim handover (issue #201): the poll-cap successor carries the predecessor's claimant in its
 * job data and drives under it, so the live claim transfers instead of stranding the run behind
 * it until the 300 s lease expires (which used to burn a resume_count per handover). Only a
 * genuinely abandoned run reaches the reaper and counts against MAX_RESUMES.
 *
 * Progress: one line per slice with the counts bastion-api also writes on the run row.
 */
import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  bastionEvaluateRunJobId,
  bastionEvaluateRunSliceSchema,
  bastionRunClaimedErrorSchema,
  type BastionEvaluateRunJobData,
} from '@bigbluebam/shared';
import { SCHEDULED_JOB_RETENTION } from '../lib/job-retention.js';
import { bodyData, parseContract, postBastion } from './bastion-shared.js';

export const EVALUATE_POLL_INTERVAL_MS = 10_000;
export const EVALUATE_MAX_POLLS = 540;
export const STALE_CLAIM_WAIT_MS = 30_000;
/** Consecutive 5xx / timeout / network failures tolerated before the job throws. */
export const TRANSIENT_MAX_CONSECUTIVE = 6;
export const TRANSIENT_WAIT_MS = 10_000;

/** The claimant a job drives under: inherited on a handover, else derived from the job id. */
export function evaluateRunClaimant(job: Pick<Job<BastionEvaluateRunJobData>, 'id' | 'data'>): string {
  return job.data.claimant ?? `worker:${job.id ?? job.data.run_id}`;
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
  const claimant = evaluateRunClaimant(job);
  const started = Date.now();
  const sleep = deps.sleep ?? realSleep;
  const maxPolls = deps.maxPolls ?? EVALUATE_MAX_POLLS;
  logger.info({ jobId: job.id, organization_id, run_id, resume_count, claimant }, 'bastion-evaluate: starting run');

  let transient = 0;
  const transientFailure = async (poll: number, detail: string): Promise<void> => {
    transient += 1;
    if (transient >= TRANSIENT_MAX_CONSECUTIVE) {
      throw new Error(`bastion-evaluate: evaluate-run failed ${transient} times in a row (last: ${detail})`);
    }
    logger.warn(
      { run_id, poll, transient, detail },
      `bastion-evaluate: engine call failed (${detail}); retrying as the same claimant in ${TRANSIENT_WAIT_MS / 1000} s (${transient}/${TRANSIENT_MAX_CONSECUTIVE})`,
    );
    await sleep(TRANSIENT_WAIT_MS);
  };

  for (let poll = 0; poll < maxPolls; poll++) {
    let res: Awaited<ReturnType<typeof postBastion>>;
    try {
      res = await deps.post('/v1/internal/engines/evaluate-run', { organization_id, run_id, claimant });
    } catch (err) {
      // A timeout (AbortSignal.timeout) or a network error. Configuration errors still throw.
      const e = err as Error;
      if (e.name !== 'TimeoutError' && e.name !== 'AbortError' && !(e instanceof TypeError)) throw err;
      await transientFailure(poll, `${e.name}: ${e.message}`);
      continue;
    }
    if (res.status >= 500) {
      await transientFailure(poll, `HTTP ${res.status}`);
      continue;
    }
    transient = 0;
    if (res.status === 404) {
      logger.warn({ run_id }, 'bastion-evaluate: run not found; ending');
      return 'ended';
    }
    if (res.status === 409) {
      const stale = parseContract(bastionRunClaimedErrorSchema, res.data, 'evaluate-run 409 body').error.heartbeat_stale;
      if (stale) {
        logger.info({ run_id }, 'bastion-evaluate: another claim has a stale heartbeat; waiting 30 s before retrying');
        await sleep(STALE_CLAIM_WAIT_MS);
        continue;
      }
      logger.info({ run_id }, 'bastion-evaluate: run is being driven by another worker; ending this attempt');
      return 'ended';
    }
    if (!res.ok) throw new Error(`bastion-evaluate: evaluate-run returned ${res.status}`);
    const raw = bodyData<unknown>(res);
    const s = raw === undefined ? undefined : parseContract(bastionEvaluateRunSliceSchema, raw, 'evaluate-run slice');
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

  // Still live after the poll cap: hand over to a fresh job (a new jobId, never deduplicated)
  // that inherits this job's claimant, so it continues the run at once.
  const generation = Math.floor(Date.now() / 1000);
  await deps.queue.add('run', { ...job.data, claimant }, {
    jobId: bastionEvaluateRunJobId(run_id, resume_count, generation),
    ...SCHEDULED_JOB_RETENTION,
  });
  logger.info({ run_id, elapsed_ms: Date.now() - started }, 'bastion-evaluate: poll cap reached; re-enqueued under a new job id');
  return 'requeued';
}
