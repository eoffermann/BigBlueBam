import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  BASTION_COMPILE_QUEUE,
  BASTION_EVALUATE_RUN_QUEUE,
  BASTION_EVIDENCE_INGEST_QUEUE,
  BASTION_QUESTIONNAIRE_AUTOFILL_QUEUE,
  bastionCompileJobId,
  bastionEvaluateRunJobId,
  bastionQuestionnaireJobId,
  type BastionCompileJobData,
  type BastionQuestionnaireJobData,
  type BastionEvaluateRunJobData,
  type BastionSweepJobData,
} from '@bigbluebam/shared';
import { env } from '../env.js';

/**
 * BullMQ producer for bastion-evaluate-run (spec 7). bastion-api enqueues a run the moment it is
 * created (POST /evaluations); the worker's evaluate-tick re-enqueues any `queued` run idle for
 * more than two minutes, so a dropped enqueue only delays a run, it never orphans one.
 *
 * Every add passes a jobId (the run id plus resume_count, spec 7.3) and the scheduled-job
 * retention, so a re-enqueue after a release is never deduplicated against a retained job and
 * Redis never fills with finished-job records. Lazy singleton: no Redis connection until first use.
 */

export const EVALUATE_RUN_JOB_RETENTION = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const;

let queue: Queue<BastionEvaluateRunJobData> | null = null;
let connection: IORedis | null = null;

function getQueue(): Queue<BastionEvaluateRunJobData> {
  if (!queue) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<BastionEvaluateRunJobData>(BASTION_EVALUATE_RUN_QUEUE, { connection });
  }
  return queue;
}

/** Best effort: false when Redis refused; the tick recovers the run within minutes. */
export async function enqueueEvaluationRun(data: BastionEvaluateRunJobData): Promise<boolean> {
  try {
    await getQueue().add('run', data, {
      jobId: bastionEvaluateRunJobId(data.run_id, data.resume_count),
      ...EVALUATE_RUN_JOB_RETENTION,
    });
    return true;
  } catch {
    return false;
  }
}

let ingestQueue: Queue<BastionSweepJobData> | null = null;

function getIngestQueue(): Queue<BastionSweepJobData> {
  if (!ingestQueue) {
    if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    ingestQueue = new Queue<BastionSweepJobData>(BASTION_EVIDENCE_INGEST_QUEUE, { connection });
  }
  return ingestQueue;
}

/**
 * Ask the worker to retry a pending virus scan soon (spec 7: bastion-evidence-ingest is event plus
 * a 10-minute sweep). Best effort: the sweep is the floor. The jobId is per item and per minute,
 * so repeated uploads in one minute collapse into one job.
 */
export async function enqueueEvidenceIngest(orgId: string, manualEvidenceId: string): Promise<boolean> {
  try {
    const minute = Math.floor(Date.now() / 60_000);
    await getIngestQueue().add('ingest', { organization_id: orgId }, {
      jobId: `ingest-${manualEvidenceId}-${minute}`,
      delay: 60_000,
      ...EVALUATE_RUN_JOB_RETENTION,
    });
    return true;
  } catch {
    return false;
  }
}

let compileQueue: Queue<BastionCompileJobData> | null = null;

function getCompileQueue(): Queue<BastionCompileJobData> {
  if (!compileQueue) {
    if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    compileQueue = new Queue<BastionCompileJobData>(BASTION_COMPILE_QUEUE, { connection });
  }
  return compileQueue;
}

/**
 * Ask the worker to drive a queued AI compile run (M7, spec 7). Best effort: the tick re-enqueues
 * a queued run nobody picked up within two minutes, so a dropped add only delays it.
 */
export async function enqueueCompileRun(data: BastionCompileJobData): Promise<boolean> {
  try {
    await getCompileQueue().add('compile', data, {
      jobId: bastionCompileJobId(data.run_id, data.resume_count),
      ...EVALUATE_RUN_JOB_RETENTION,
    });
    return true;
  } catch {
    return false;
  }
}

let autofillQueue: Queue<BastionQuestionnaireJobData> | null = null;

function getAutofillQueue(): Queue<BastionQuestionnaireJobData> {
  if (!autofillQueue) {
    if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    autofillQueue = new Queue<BastionQuestionnaireJobData>(BASTION_QUESTIONNAIRE_AUTOFILL_QUEUE, { connection });
  }
  return autofillQueue;
}

/**
 * Ask the worker to draft a questionnaire's answers (M8, spec 7). Best effort: the tick re-enqueues
 * an answering questionnaire nobody claimed within two minutes, so a dropped add only delays it.
 */
export async function enqueueQuestionnaireAutofill(data: BastionQuestionnaireJobData): Promise<boolean> {
  try {
    await getAutofillQueue().add('autofill', data, {
      jobId: bastionQuestionnaireJobId(data.questionnaire_id, data.resume_count, Math.floor(Date.now() / 1000)),
      ...EVALUATE_RUN_JOB_RETENTION,
    });
    return true;
  } catch {
    return false;
  }
}

export async function closeBastionQueues(): Promise<void> {
  await autofillQueue?.close().catch(() => {});
  autofillQueue = null;
  await compileQueue?.close().catch(() => {});
  compileQueue = null;
  await ingestQueue?.close().catch(() => {});
  ingestQueue = null;
  await queue?.close().catch(() => {});
  queue = null;
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
