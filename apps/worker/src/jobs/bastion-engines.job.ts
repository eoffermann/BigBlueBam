/**
 * The scheduled Bastion jobs (spec 7): thin callers into bastion-api's engines route. All engine
 * logic, locks and keys live in bastion-api; each job logs a start line before its one slow step
 * and a completion line with the engine's own summary and the elapsed time (spec 7.1).
 *
 * bastion-evaluate-tick also enqueues the runs the engine returns: every add passes a jobId (the
 * run id plus resume_count, and a generation for orphan re-enqueues so a retained completed job
 * never swallows it) and SCHEDULED_JOB_RETENTION (scanned by bastion-jobs.test.ts).
 */
import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  bastionEvaluateRunJobId,
  type BastionEngineName,
  type BastionEvaluateRunJobData,
  type BastionSweepJobData,
} from '@bigbluebam/shared';
import { SCHEDULED_JOB_RETENTION } from '../lib/job-retention.js';
import { bodyData, postBastion } from './bastion-shared.js';

export interface EngineJobDeps {
  post: typeof postBastion;
  /** Reports a delivery that gave up (dead outbox rows) as a worker error. */
  recordError?: (message: string, details: Record<string, unknown>) => void;
}

/** A scheduled job that calls one engine and logs its summary. */
export function makeBastionEngineJob(engine: Exclude<BastionEngineName, 'evaluate-run' | 'evaluate-tick'>, deps: EngineJobDeps) {
  return async function processBastionEngineJob(job: Job<BastionSweepJobData>, logger: Logger): Promise<unknown> {
    const started = Date.now();
    logger.info({ jobId: job.id, engine }, `bastion-${engine}: starting`);
    const res = await deps.post(`/v1/internal/engines/${engine}`, job.data?.organization_id ? { organization_id: job.data.organization_id } : {});
    if (!res.ok) throw new Error(`bastion-${engine}: engine returned ${res.status}`);
    const summary = bodyData<Record<string, unknown>>(res);
    if (engine === 'outbox-drain' && summary && Number(summary.dead ?? 0) > 0) {
      deps.recordError?.(`bastion-outbox: ${summary.dead} deliveries gave up and are dead`, { dead_ids: summary.dead_ids });
    }
    logger.info({ jobId: job.id, engine, elapsedMs: Date.now() - started, summary }, `bastion-${engine}: complete`);
    return summary;
  };
}

interface TickRun {
  organization_id: string;
  run_id: string;
  resume_count: number;
  generation: number;
  why: string;
}

/** evaluate-tick: ask the engine which runs to drive, then enqueue each one. */
export async function processBastionEvaluateTickJob(
  job: Job<BastionSweepJobData>,
  logger: Logger,
  deps: EngineJobDeps & { queue: Pick<Queue<BastionEvaluateRunJobData>, 'add'> },
): Promise<number> {
  const started = Date.now();
  logger.info({ jobId: job.id }, 'bastion-evaluate-tick: checking for due, resumable and orphaned runs');
  const res = await deps.post('/v1/internal/engines/evaluate-tick', job.data?.organization_id ? { organization_id: job.data.organization_id } : {});
  if (!res.ok) throw new Error(`bastion-evaluate-tick: engine returned ${res.status}`);
  const runs = bodyData<{ runs: TickRun[] }>(res)?.runs ?? [];
  for (const [i, r] of runs.entries()) {
    await deps.queue.add(
      'run',
      { organization_id: r.organization_id, run_id: r.run_id, resume_count: r.resume_count },
      { jobId: bastionEvaluateRunJobId(r.run_id, r.resume_count, r.generation), ...SCHEDULED_JOB_RETENTION },
    );
    logger.info({ run_id: r.run_id, why: r.why }, `bastion-evaluate-tick: enqueued ${i + 1}/${runs.length}`);
  }
  logger.info({ jobId: job.id, enqueued: runs.length, elapsedMs: Date.now() - started }, 'bastion-evaluate-tick: complete');
  return runs.length;
}
