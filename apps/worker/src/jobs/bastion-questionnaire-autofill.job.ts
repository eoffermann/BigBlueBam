/**
 * bastion-questionnaire-autofill (Bastion spec 2.7, 7, 7.1, 7.3; M8). Event-driven: bastion-api
 * enqueues it when someone asks Bastion to draft a questionnaire's answers, and
 * bastion-evaluate-tick re-enqueues any answering questionnaire nobody claimed (a dropped enqueue,
 * or one released by a deploy). Async-start LLM slices, exactly like bastion-compile: each engine
 * call starts a slice inside bastion-api (or reports on the one running) and answers at once; this
 * job polls every 10 s, at most MAX_POLLS (360 x 10 s = 1 hour, above the 16-32 minute estimate
 * for a 96-row questionnaire), then re-enqueues itself under a new jobId with the same claimant
 * (the issue #201 handover). Slices skip rows already drafted, so any re-drive is idempotent.
 *
 *   200 done        the questionnaire left `answering` (drafted, or parked to review); end.
 *   200 released    bastion-api is shutting down and gave it back; end (the tick re-enqueues).
 *   200 running     a slice is going (or just ended); poll again.
 *   404             the questionnaire is gone; end.
 *   409 stale       another claimant's heartbeat is stale: wait 30 s and retry.
 *   409 live        another worker is drafting it; end this attempt.
 *   5xx / timeout   transient: wait and poll again under the SAME claimant; after
 *                   TRANSIENT_MAX_CONSECUTIVE in a row the job throws.
 *
 * Progress (spec 7.1): one line per poll, "bastion-autofill: questionnaire <id> rows 40/96 (high
 * 22, medium 11, low 7)", plus "waiting for an AI slot" and "throttled by the AI provider".
 */
import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import {
  bastionQuestionnaireJobId,
  bastionQuestionnaireSliceSchema,
  bastionRunClaimedErrorSchema,
  type BastionQuestionnaireJobData,
} from '@bigbluebam/shared';
import { SCHEDULED_JOB_RETENTION } from '../lib/job-retention.js';
import { bodyData, parseContract, type postBastion } from './bastion-shared.js';

export const AUTOFILL_POLL_INTERVAL_MS = 10_000;
export const AUTOFILL_MAX_POLLS = 360;
export const AUTOFILL_STALE_CLAIM_WAIT_MS = 30_000;
export const AUTOFILL_TRANSIENT_MAX_CONSECUTIVE = 6;

export function autofillClaimant(job: Pick<Job<BastionQuestionnaireJobData>, 'id' | 'data'>): string {
  return job.data.claimant ?? `worker-autofill:${job.id ?? job.data.questionnaire_id}`;
}

export interface AutofillJobDeps {
  post: typeof postBastion;
  sleep?: (ms: number) => Promise<void>;
  queue: Pick<Queue<BastionQuestionnaireJobData>, 'add'>;
  maxPolls?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function processBastionQuestionnaireAutofillJob(
  job: Job<BastionQuestionnaireJobData>,
  logger: Logger,
  deps: AutofillJobDeps,
): Promise<'done' | 'ended' | 'requeued'> {
  const { organization_id, questionnaire_id, resume_count } = job.data;
  const claimant = autofillClaimant(job);
  const sleep = deps.sleep ?? realSleep;
  const maxPolls = deps.maxPolls ?? AUTOFILL_MAX_POLLS;
  const started = Date.now();
  logger.info(
    { jobId: job.id, organization_id, questionnaire_id, resume_count, claimant },
    'bastion-autofill: starting to draft questionnaire answers (each AI answer takes 10-20 s; a 96-row questionnaire about 16-32 minutes)',
  );

  let transient = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    let res: Awaited<ReturnType<typeof postBastion>>;
    try {
      res = await deps.post('/v1/internal/engines/questionnaire-autofill', { organization_id, questionnaire_id, claimant });
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'TimeoutError' && e.name !== 'AbortError' && !(e instanceof TypeError)) throw err;
      transient += 1;
      if (transient >= AUTOFILL_TRANSIENT_MAX_CONSECUTIVE) throw new Error(`bastion-autofill: engine call failed ${transient} times in a row (last: ${e.message})`);
      logger.warn({ questionnaire_id, poll, transient }, `bastion-autofill: engine call failed (${e.name}); retrying as the same claimant`);
      await sleep(AUTOFILL_POLL_INTERVAL_MS);
      continue;
    }
    if (res.status >= 500) {
      transient += 1;
      if (transient >= AUTOFILL_TRANSIENT_MAX_CONSECUTIVE) throw new Error(`bastion-autofill: engine returned ${res.status} ${transient} times in a row`);
      logger.warn({ questionnaire_id, poll, transient, status: res.status }, 'bastion-autofill: engine error; retrying as the same claimant');
      await sleep(AUTOFILL_POLL_INTERVAL_MS);
      continue;
    }
    transient = 0;
    if (res.status === 404) {
      logger.warn({ questionnaire_id }, 'bastion-autofill: questionnaire not found; ending');
      return 'ended';
    }
    if (res.status === 409) {
      const stale = parseContract(bastionRunClaimedErrorSchema, res.data, 'questionnaire-autofill 409 body').error.heartbeat_stale;
      if (stale) {
        logger.info({ questionnaire_id }, 'bastion-autofill: another claim has a stale heartbeat; waiting 30 s before retrying');
        await sleep(AUTOFILL_STALE_CLAIM_WAIT_MS);
        continue;
      }
      logger.info({ questionnaire_id }, 'bastion-autofill: another worker is drafting this questionnaire; ending this attempt');
      return 'ended';
    }
    if (!res.ok) throw new Error(`bastion-autofill: engine returned ${res.status}`);
    const raw = bodyData<unknown>(res);
    const s = raw === undefined ? undefined : parseContract(bastionQuestionnaireSliceSchema, raw, 'questionnaire-autofill slice');
    if (s) {
      const wait = s.waiting === 'ai_slot' ? ' waiting for an AI slot (org limit 1)' : s.waiting === 'ai_throttled' ? ' throttled by the AI provider, resuming in 30 s' : '';
      logger.info(
        { questionnaire_id, poll, status: s.status, slice_running: s.slice_running },
        `bastion-autofill: questionnaire ${questionnaire_id} rows ${s.rows_done}/${s.row_count} (high ${s.high}, medium ${s.medium}, low ${s.low})${wait} elapsed_ms=${Date.now() - started}`,
      );
      if (s.done) return 'done';
      if (s.released) {
        logger.info({ questionnaire_id }, 'bastion-autofill: bastion-api released the questionnaire while shutting down; the tick re-enqueues it');
        return 'ended';
      }
    }
    await sleep(AUTOFILL_POLL_INTERVAL_MS);
  }

  const generation = Math.floor(Date.now() / 1000);
  await deps.queue.add('autofill', { ...job.data, claimant }, { jobId: bastionQuestionnaireJobId(questionnaire_id, resume_count, generation), ...SCHEDULED_JOB_RETENTION });
  logger.info({ questionnaire_id, elapsed_ms: Date.now() - started }, 'bastion-autofill: poll cap reached; re-enqueued under a new job id');
  return 'requeued';
}
