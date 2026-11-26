/**
 * bastion-compile (Bastion spec 7, 7.1, 7.3; M7). Event-driven: bastion-api enqueues it when an
 * AI-tailored compile run is created, and bastion-evaluate-tick re-enqueues any queued compile run
 * nobody picked up (a dropped enqueue, or a run released by a deploy). Async-start LLM slices:
 * each engine call starts a slice inside bastion-api (or reports on the one running) and answers
 * at once; this job polls every 15 s, at most MAX_POLLS (960 x 15 s = 4 hours, above the 1-2 hour
 * estimate for a 400-call compile), then re-enqueues itself under a new jobId with the same
 * claimant (the issue #201 handover). Slices skip controls already written, so any re-drive is
 * idempotent.
 *
 *   200 done        the run finished (succeeded, partial or failed); end.
 *   200 released    bastion-api is shutting down and gave the run back; end (the tick re-enqueues).
 *   200 running     a slice is going (or just ended); poll again.
 *   404             the run is gone; end.
 *   409 stale       another claimant's heartbeat is stale: wait 30 s and retry.
 *   409 live        another worker is driving it; end this attempt.
 *   5xx / timeout   transient: wait and poll again under the SAME claimant; after
 *                   TRANSIENT_MAX_CONSECUTIVE in a row the job throws.
 *
 * Progress (spec 7.1): one line per poll with the counts bastion-api writes on the run row, plus
 * "waiting for an AI slot" and "throttled by the AI provider" when the slice is waiting.
 */
import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { bastionCompileJobId, bastionCompileSliceSchema, bastionRunClaimedErrorSchema, type BastionCompileJobData } from '@bigbluebam/shared';
import { SCHEDULED_JOB_RETENTION } from '../lib/job-retention.js';
import { bodyData, parseContract, postBastion } from './bastion-shared.js';

export const COMPILE_POLL_INTERVAL_MS = 15_000;
export const COMPILE_MAX_POLLS = 960;
export const COMPILE_STALE_CLAIM_WAIT_MS = 30_000;
export const COMPILE_TRANSIENT_MAX_CONSECUTIVE = 6;

export function compileClaimant(job: Pick<Job<BastionCompileJobData>, 'id' | 'data'>): string {
  return job.data.claimant ?? `worker-compile:${job.id ?? job.data.run_id}`;
}

export interface CompileJobDeps {
  post: typeof postBastion;
  sleep?: (ms: number) => Promise<void>;
  queue: Pick<Queue<BastionCompileJobData>, 'add'>;
  maxPolls?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function processBastionCompileJob(
  job: Job<BastionCompileJobData>,
  logger: Logger,
  deps: CompileJobDeps,
): Promise<'done' | 'ended' | 'requeued'> {
  const { organization_id, run_id, resume_count } = job.data;
  const claimant = compileClaimant(job);
  const sleep = deps.sleep ?? realSleep;
  const maxPolls = deps.maxPolls ?? COMPILE_MAX_POLLS;
  const started = Date.now();
  logger.info(
    { jobId: job.id, organization_id, run_id, resume_count, claimant },
    'bastion-compile: starting the AI-tailored compile (each AI call takes 10-20 s; a full compile can take 1-2 hours)',
  );

  let transient = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    let res: Awaited<ReturnType<typeof postBastion>>;
    try {
      res = await deps.post('/v1/internal/engines/compile', { organization_id, run_id, claimant });
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'TimeoutError' && e.name !== 'AbortError' && !(e instanceof TypeError)) throw err;
      transient += 1;
      if (transient >= COMPILE_TRANSIENT_MAX_CONSECUTIVE) throw new Error(`bastion-compile: engine call failed ${transient} times in a row (last: ${e.message})`);
      logger.warn({ run_id, poll, transient }, `bastion-compile: engine call failed (${e.name}); retrying as the same claimant`);
      await sleep(COMPILE_POLL_INTERVAL_MS);
      continue;
    }
    if (res.status >= 500) {
      transient += 1;
      if (transient >= COMPILE_TRANSIENT_MAX_CONSECUTIVE) throw new Error(`bastion-compile: engine returned ${res.status} ${transient} times in a row`);
      logger.warn({ run_id, poll, transient, status: res.status }, 'bastion-compile: engine error; retrying as the same claimant');
      await sleep(COMPILE_POLL_INTERVAL_MS);
      continue;
    }
    transient = 0;
    if (res.status === 404) {
      logger.warn({ run_id }, 'bastion-compile: run not found; ending');
      return 'ended';
    }
    if (res.status === 409) {
      const stale = parseContract(bastionRunClaimedErrorSchema, res.data, 'compile 409 body').error.heartbeat_stale;
      if (stale) {
        logger.info({ run_id }, 'bastion-compile: another claim has a stale heartbeat; waiting 30 s before retrying');
        await sleep(COMPILE_STALE_CLAIM_WAIT_MS);
        continue;
      }
      logger.info({ run_id }, 'bastion-compile: run is being driven by another worker; ending this attempt');
      return 'ended';
    }
    if (!res.ok) throw new Error(`bastion-compile: engine returned ${res.status}`);
    const raw = bodyData<unknown>(res);
    const s = raw === undefined ? undefined : parseContract(bastionCompileSliceSchema, raw, 'compile slice');
    if (s) {
      const wait = s.waiting === 'ai_slot' ? ' waiting for an AI slot (org limit 1)' : s.waiting === 'ai_throttled' ? ' throttled by the AI provider, resuming in 30 s' : '';
      logger.info(
        { run_id, poll, status: s.status, slice_running: s.slice_running },
        `bastion-compile: run ${run_id} controls ${s.controls_done}/${s.controls_total} proposed ${s.assertions_proposed} dropped ${s.assertions_dropped} llm_calls ${s.llm_calls_used} fallback=${s.fallback_controls > 0}${wait} elapsed_ms=${Date.now() - started}`,
      );
      if (s.done) return 'done';
      if (s.released) {
        logger.info({ run_id }, 'bastion-compile: bastion-api released the run while shutting down; the tick re-enqueues it');
        return 'ended';
      }
    }
    await sleep(COMPILE_POLL_INTERVAL_MS);
  }

  const generation = Math.floor(Date.now() / 1000);
  await deps.queue.add('compile', { ...job.data, claimant }, { jobId: bastionCompileJobId(run_id, resume_count, generation), ...SCHEDULED_JOB_RETENTION });
  logger.info({ run_id, elapsed_ms: Date.now() - started }, 'bastion-compile: poll cap reached; re-enqueued under a new job id');
  return 'requeued';
}
