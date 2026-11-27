/**
 * bastion-object-backup (Bastion spec 7, 9.7; M9): the off-site evidence copy that follows every
 * database backup.
 *
 * backup-database.job.ts records its own `completed` status FIRST, exactly as before, and only
 * then enqueues this job with jobId = the backup id. This job is a thin caller into bastion-api's
 * `mirror-objects` engine (the off-site credentials live only in bastion-api): each call copies as
 * much as fits in about 20 seconds and answers `complete: false` while more remains inside the
 * per-backup budget (5,000 objects or 2 GiB), so the job calls again, logging progress each time.
 *
 * A mirror failure, timeout or a long first pass NEVER changes the database backup's own status:
 * the engine records failures on platform_backups.bastion_mirror_status only, and if bastion-api
 * cannot be reached at all this job records `failed` there itself (recordMirrorFailure) before
 * the job fails.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  BASTION_MIRROR_CALL_TIMEOUT_MS,
  bastionMirrorResultSchema,
  type BastionMirrorResult,
  type BastionObjectBackupJobData,
} from '@bigbluebam/shared';
import { bodyData, parseContract, postBastion } from './bastion-shared.js';

/** Upper bound on engine calls in one job (about 20 s of copying each). */
export const MIRROR_MAX_CALLS = 240;
/**
 * One mirror call may start a copy of the largest evidence object at the end of its 20 s budget,
 * and that copy is allowed BASTION_MIRROR_MAX_COPY_MS at the floor rate; the shared constant is
 * derived from both, so the worker never gives up on a call the engine is still entitled to (#332).
 */
const MIRROR_CALL_TIMEOUT_MS = BASTION_MIRROR_CALL_TIMEOUT_MS;
const MAX_TRANSIENT = 5;

export interface ObjectBackupDeps {
  post: typeof postBastion;
  /** Writes platform_backups.bastion_mirror_status = 'failed' (never the backup's own status). */
  recordMirrorFailure: (backupId: string, message: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxCalls?: number;
}

export async function processBastionObjectBackupJob(
  job: Job<BastionObjectBackupJobData>,
  logger: Logger,
  deps: ObjectBackupDeps,
): Promise<BastionMirrorResult | null> {
  const started = Date.now();
  const backupId = job.data.backup_id;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  logger.info({ jobId: job.id, backup_id: backupId }, 'bastion-object-backup: starting the off-site evidence copy for this database backup');
  let last: BastionMirrorResult | null = null;
  let copied = 0;
  let transient = 0;
  try {
    for (let call = 1; call <= (deps.maxCalls ?? MIRROR_MAX_CALLS); call++) {
      let res: Awaited<ReturnType<typeof postBastion>>;
      try {
        res = await deps.post('/v1/internal/engines/mirror-objects', { backup_id: backupId }, MIRROR_CALL_TIMEOUT_MS);
      } catch (err) {
        if ((err as Error).message.includes('INTERNAL_SERVICE_SECRET') || (err as Error).name === 'BastionUrlMissingError') throw err;
        res = { ok: false, status: 0 };
      }
      if (!res.ok) {
        transient += 1;
        if (res.status === 400 || res.status === 404 || transient > MAX_TRANSIENT) {
          throw new Error(`bastion-object-backup: mirror-objects returned ${res.status} (${transient} times in a row)`);
        }
        logger.warn({ backup_id: backupId, status: res.status, attempt: transient }, 'bastion-object-backup: bastion-api did not answer; retrying in 30 s');
        await sleep(30_000);
        continue;
      }
      transient = 0;
      last = parseContract(bastionMirrorResultSchema, bodyData(res), 'mirror-objects result');
      copied += last.mirrored;
      logger.info(
        { backup_id: backupId, call, status: last.status, copied_this_call: last.mirrored, remaining: last.remaining, elapsedMs: Date.now() - started },
        `bastion-object-backup: objects ${copied} copied so far, ${last.remaining} still to copy (${last.status})`,
      );
      if (last.complete) break;
    }
  } catch (err) {
    const msg = (err as Error).message;
    logger.error({ backup_id: backupId, err: msg }, 'bastion-object-backup: the off-site copy failed; the database backup itself is unaffected');
    await deps.recordMirrorFailure(backupId, msg).catch((e: Error) =>
      logger.error({ backup_id: backupId, err: e.message }, 'bastion-object-backup: could not record the mirror failure on the backup row'),
    );
    throw err;
  }
  if (last && !last.complete) {
    logger.warn({ backup_id: backupId }, 'bastion-object-backup: stopped after the call limit; the next backup resumes from the cursor');
  }
  if (last?.status === 'not_configured') logger.info({ backup_id: backupId }, 'bastion-object-backup: No off-site evidence backup is configured');
  logger.info({ backup_id: backupId, status: last?.status ?? null, copied, elapsedMs: Date.now() - started }, 'bastion-object-backup: complete');
  return last;
}
