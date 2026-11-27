// Bucket housekeeping for Bastion's own bucket (spec 3.3, 3.4, 7, 9.7; M9):
//
//   objectSweep          the daily `object-sweep` engine. Scans only bastion_object_intents older
//                        than 24 h, so its cost is bounded by failed writes, never by the bucket's
//                        size. Paused for an org with an unresolved restore row (after a database
//                        restore the rows may be behind the bucket, and deleting "orphans" then
//                        would destroy evidence the restore lost).
//   mirrorObjects        the `mirror-objects` engine the worker calls after every successful
//                        database backup: copies evidence objects with mirrored_at IS NULL (and
//                        every seal and restore record) to the separately configured off-site
//                        destination within a per-backup budget, and records the outcome on the
//                        backup row. It never touches the backup's own status.
//   restoreObjectsFromBackup  the `restore-objects --from-backup` CLI: copies the mirror back.
//
// The mirror destination is a second driver built from BASTION_BACKUP_S3_*; its credentials live
// only in bastion-api (spec 9.1).

import type { Readable } from 'node:stream';
import { type StorageDriver, isStorageNotFoundError, withStorageTimeout } from '@bigbluebam/storage';
import {
  BASTION_MIRROR_COPY_FLOOR_MS,
  BASTION_MIRROR_MAX_COPY_MS,
  BASTION_MIRROR_TIME_BUDGET_MS,
  bastionTransferTimeoutMs,
  type BastionMirrorResult,
  type BastionMirrorStatus,
  type BastionObjectSweepResult,
} from '@bigbluebam/shared';
import { type EngineDeps, orgTx } from './context.js';
import { listPages } from './restore.js';

/** An intent younger than this may belong to a write still in flight (spec 7). */
export const SWEEP_INTENT_AGE_MS = 24 * 3_600_000;
/** One sweep call stays well inside the 30 s engine timeout; `complete: false` asks for another. */
const SWEEP_TIME_BUDGET_MS = 20_000;
const SWEEP_BATCH = 500;

export async function objectSweep(deps: EngineDeps, opts: { organization_id?: string } = {}): Promise<BastionObjectSweepResult> {
  const started = Date.now();
  const out: BastionObjectSweepResult = { checked: 0, removed_orphans: 0, cleared_intents: 0, deleted_redacted: 0, failed: 0, paused_orgs: 0, complete: true };
  const storage = deps.storage;
  deps.log.info({ organization_id: opts.organization_id ?? null }, 'bastion-object-sweep: starting (intents older than 24 hours)');
  if (!storage) {
    deps.log.warn({}, "bastion-object-sweep: evidence storage isn't set up; nothing to sweep");
    return out;
  }
  const cutoff = new Date(deps.now().getTime() - SWEEP_INTENT_AGE_MS);
  const paused = new Set(
    (
      await deps.sql`SELECT DISTINCT organization_id FROM bastion_ledger_restores WHERE resolution IS NULL
                      ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}`
    ).map((r) => String(r.organization_id)),
  );
  out.paused_orgs = paused.size;
  const candidates = await deps.sql`
    SELECT organization_id, object_key FROM bastion_object_intents
     WHERE created_at < ${cutoff}
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
       ${paused.size > 0 ? deps.sql`AND NOT (organization_id = ANY(${[...paused]}::uuid[]))` : deps.sql``}
     ORDER BY created_at, object_key LIMIT ${SWEEP_BATCH}`;
  for (const [i, c] of candidates.entries()) {
    if (Date.now() - started > SWEEP_TIME_BUDGET_MS) {
      out.complete = false;
      break;
    }
    const orgId = String(c.organization_id);
    const key = String(c.object_key);
    out.checked += 1;
    try {
      const result = await orgTx(deps.sql, orgId, async (tx) => {
        // Re-read under a row lock and re-check the age: a writer that reuses a content-addressed
        // key refreshes created_at first (ON CONFLICT DO UPDATE), and waits on this lock.
        const intent = (await tx`SELECT object_key FROM bastion_object_intents
                                  WHERE object_key = ${key} AND created_at < ${cutoff} FOR UPDATE SKIP LOCKED`)[0];
        if (!intent) return 'skipped' as const;
        const obj = (await tx`SELECT bytes_redacted_at FROM bastion_evidence_objects
                               WHERE organization_id = ${orgId} AND object_key = ${key}`)[0];
        if (obj && !obj.bytes_redacted_at) {
          // The object row landed; the intent is only a leftover.
          await tx`DELETE FROM bastion_object_intents WHERE object_key = ${key}`;
          return 'cleared' as const;
        }
        // No row holds these bytes (a put whose row never landed, or a duplicate copy), or the row
        // says they were redacted: the bytes go, then the intent.
        try {
          await withStorageTimeout('delete', storage.delete(key), deps.putTimeoutMs);
        } catch (err) {
          if (!isStorageNotFoundError(err)) throw err;
        }
        await tx`DELETE FROM bastion_object_intents WHERE object_key = ${key}`;
        return obj ? ('deleted_redacted' as const) : ('removed_orphan' as const);
      });
      if (result === 'cleared') out.cleared_intents += 1;
      else if (result === 'deleted_redacted') out.deleted_redacted += 1;
      else if (result === 'removed_orphan') out.removed_orphans += 1;
    } catch (err) {
      out.failed += 1;
      deps.log.warn({ organization_id: orgId, err: (err as Error).message }, 'bastion-object-sweep: one leftover could not be removed; the next sweep retries it');
    }
    if ((i + 1) % 50 === 0 || i + 1 === candidates.length) {
      deps.log.info(
        { checked: out.checked, elapsed_ms: Date.now() - started },
        `bastion-object-sweep: checked ${i + 1}/${candidates.length}, budget remaining ${Math.max(0, SWEEP_TIME_BUDGET_MS - (Date.now() - started))} ms`,
      );
    }
  }
  if (candidates.length === SWEEP_BATCH) out.complete = false;
  if (paused.size > 0) deps.log.info({ paused_orgs: paused.size }, 'bastion-object-sweep: paused for organizations with an unresolved restore');
  deps.log.info({ ...out, elapsed_ms: Date.now() - started }, 'bastion-object-sweep: done');
  return out;
}

// ── Off-site mirror ──────────────────────────────────────────────────────────────────────

/** Per database backup (spec 9.7): at most 5,000 objects or 2 GiB, resumed after the next backup. */
export const MIRROR_BUDGET_OBJECTS = 5_000;
export const MIRROR_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
/** One engine call; the worker calls again while `complete` is false. */
const MIRROR_TIME_BUDGET_MS = BASTION_MIRROR_TIME_BUDGET_MS;
/**
 * Copies that fail one after another, with none succeeding in between, before the pass is treated
 * as a destination problem and ends `failed` (#332). Fewer than this is a per-object problem: the
 * object is recorded and skipped, and the pass goes on.
 */
export const MIRROR_MAX_CONSECUTIVE_FAILURES = 5;
/** Errors that mean the destination as a whole is unusable (credentials, bucket), never one object. */
const DESTINATION_ERROR_CODES = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'NoSuchBucket', 'ExpiredToken', 'InvalidBucketName']);
function isDestinationWideError(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown };
  return DESTINATION_ERROR_CODES.has(String(e?.code ?? '')) || DESTINATION_ERROR_CODES.has(String(e?.name ?? ''));
}
/** "Current" (spec 9.7): every object created before the backup's start minus 1 hour is mirrored. */
const CURRENT_SLACK_MS = 3_600_000;
/** Bastion's own prefixes that are not evidence-object rows but must survive a lost bucket. */
export const MIRRORED_RECORD_PREFIXES = ['seals/', 'restores/'] as const;
/** Everything the restore CLI copies back (packets are rebuilt, never mirrored). */
export const RESTORABLE_PREFIXES = ['evidence/', 'manual/', 'seals/', 'restores/'] as const;

export interface MirrorOptions {
  backup_id?: string;
  /** Tests shrink the per-call time budget. */
  timeBudgetMs?: number;
}

interface MirrorProgress {
  objects: number;
  bytes: number;
  records_done: boolean;
  /** Resume point of an unfinished records step: index into MIRRORED_RECORD_PREFIXES and last key done. */
  records_prefix?: number;
  records_after?: string | null;
  /** When the current records step began (becomes the next high-water mark when it finishes). */
  records_started?: string;
  /** When this pass's object step began: an object whose copy failed since then is not retried in this pass (#332). */
  objects_started?: string;
  /** The last evidence object this pass handled; the next call resumes after it (#332). */
  objects_after?: ObjectsCursor;
}

/** Keyset position in the object step's order; created_at is Postgres text (microseconds kept). */
interface ObjectsCursor {
  attempts: number;
  created_at: string;
  object_key: string;
}

/**
 * High-water mark of the records step, surviving the per-backup reset (#309): seal and restore
 * records modified before it were already checked by an earlier finished pass, so they are listed
 * but not stat'ed again. Seals are written once per key; a rewritten object gets a new modified
 * time and is checked again. Deleting this key forces a full re-check (for example after pointing
 * the mirror at a new destination).
 */
export const MIRROR_RECORDS_SINCE_KEY = 'bastion:mirror:records-since';
const FRESH_PROGRESS: MirrorProgress = { objects: 0, bytes: 0, records_done: false };

/**
 * The put deadline for one mirror copy (#332): the object's size at the shared floor rate, at least
 * a minute, and never more than the largest object's deadline (which the worker's call timeout is
 * built from). `sizeBytes` is the row's size_bytes, or the source's own size when it is larger.
 */
export function mirrorCopyTimeoutMs(sizeBytes: number, timeoutMs: number): number {
  return Math.min(
    BASTION_MIRROR_MAX_COPY_MS,
    Math.max(timeoutMs, bastionTransferTimeoutMs(sizeBytes, BASTION_MIRROR_COPY_FLOOR_MS)),
  );
}

async function copyObject(source: StorageDriver, dest: StorageDriver, key: string, timeoutMs: number, sizeBytes = 0): Promise<number> {
  const got = await withStorageTimeout('get', source.getStream(key), timeoutMs);
  try {
    const put = await withStorageTimeout(
      'put',
      dest.put(key, got.stream as Readable, { contentType: got.contentType, size: got.size }),
      mirrorCopyTimeoutMs(Math.max(sizeBytes, got.size ?? 0), timeoutMs),
    );
    return put.size || got.size;
  } catch (err) {
    (got.stream as { destroy?: () => void }).destroy?.();
    throw err;
  }
}

/**
 * Record the mirror outcome on the backup row. platform_backups is platform-wide (no org column,
 * no RLS). Only the mirror columns are written: the backup's own status is never touched (spec
 * 9.7). `fenced` writes (the end of a call) land only while the row still says `running`, so a
 * call the worker already gave up on (and recorded `failed` for) can never overwrite that outcome
 * when it finally finishes (#309). The start of a call is unfenced: a new call is a new attempt.
 */
async function writeMirrorStatus(
  deps: EngineDeps,
  backupId: string | undefined,
  status: BastionMirrorStatus,
  cursor: Date | null,
  fenced = false,
): Promise<boolean> {
  if (!backupId) return true;
  const rows = await deps.sql`UPDATE platform_backups SET bastion_mirror_status = ${status}, bastion_mirror_cursor = ${cursor}
                               WHERE id = ${backupId} ${fenced ? deps.sql`AND bastion_mirror_status = 'running'` : deps.sql``}
                              RETURNING id`;
  return rows.length > 0;
}

/**
 * One budgeted mirror call. Returns `complete: false` while there is more to copy inside the
 * per-backup budget; the worker calls again. A destination failure ends the pass `failed`
 * (recorded on the backup row) without ever changing the database backup's own status.
 */
export async function mirrorObjects(deps: EngineDeps, dest: StorageDriver | null, opts: MirrorOptions = {}): Promise<BastionMirrorResult> {
  const started = Date.now();
  const timeBudget = opts.timeBudgetMs ?? MIRROR_TIME_BUDGET_MS;
  const base: BastionMirrorResult = {
    status: 'running',
    mirrored: 0,
    bytes: 0,
    failed: 0,
    removed_redacted: 0,
    seals_and_records: 0,
    remaining: 0,
    cursor: null,
    complete: false,
    error: null,
  };
  if (!dest) {
    deps.log.info({ backup_id: opts.backup_id ?? null }, 'bastion-mirror: No off-site evidence backup is configured');
    await writeMirrorStatus(deps, opts.backup_id, 'not_configured', null);
    return { ...base, status: 'not_configured', complete: true };
  }
  const source = deps.storage;
  if (!source) {
    const error = "Evidence storage isn't set up, so there is nothing to copy off-site.";
    await writeMirrorStatus(deps, opts.backup_id, 'failed', null);
    return { ...base, status: 'failed', complete: true, error };
  }
  const backup = opts.backup_id
    ? ((await deps.sql`SELECT started_at, status FROM platform_backups WHERE id = ${opts.backup_id}`)[0] ?? null)
    : null;
  const horizon = new Date(
    (backup?.started_at ? new Date(backup.started_at as string).getTime() : deps.now().getTime()) - CURRENT_SLACK_MS,
  );
  const progressKey = `bastion:mirror:${opts.backup_id ?? 'manual'}`;
  const progress: MirrorProgress = { ...FRESH_PROGRESS, ...JSON.parse((await deps.cursors.get(progressKey)) ?? '{}') };
  deps.log.info(
    { backup_id: opts.backup_id ?? null, objects_so_far: progress.objects, bytes_so_far: progress.bytes, records_done: progress.records_done },
    'bastion-mirror: starting a pass to the off-site evidence backup',
  );
  if (progress.objects === 0 && progress.bytes === 0 && !progress.records_after && !progress.records_prefix) {
    await writeMirrorStatus(deps, opts.backup_id, 'running', null);
  } else if (opts.backup_id) {
    // A resumed call is a live attempt again (keeps the recorded cursor).
    await deps.sql`UPDATE platform_backups SET bastion_mirror_status = 'running'
                    WHERE id = ${opts.backup_id} AND bastion_mirror_status IS DISTINCT FROM 'running'`;
  }
  const out = { ...base };
  const fail = async (err: unknown) => {
    const error = `The off-site evidence backup could not be written: ${(err as Error).message}`.slice(0, 500);
    deps.log.error({ backup_id: opts.backup_id ?? null, err: (err as Error).message }, 'bastion-mirror: pass failed; the database backup itself is unaffected');
    const remaining = await unmirroredBefore(deps, null);
    await writeMirrorStatus(deps, opts.backup_id, 'failed', remaining.oldest, true);
    await deps.cursors.set(progressKey, JSON.stringify(progress));
    return { ...out, status: 'failed' as const, complete: true, error, remaining: remaining.count, cursor: remaining.oldest?.toISOString() ?? null };
  };

  try {
    // 1. Bytes redacted after they were mirrored leave the mirror too.
    const redacted = await deps.sql`SELECT organization_id, content_sha256, object_key FROM bastion_evidence_objects
                                     WHERE bytes_redacted_at IS NOT NULL AND mirrored_at IS NOT NULL LIMIT 500`;
    for (const r of redacted) {
      try {
        await withStorageTimeout('delete', dest.delete(String(r.object_key)), deps.putTimeoutMs);
      } catch (err) {
        if (!isStorageNotFoundError(err)) throw err;
      }
      await orgTx(deps.sql, String(r.organization_id), (tx) => tx`
        UPDATE bastion_evidence_objects SET mirrored_at = NULL
         WHERE organization_id = ${String(r.organization_id)} AND content_sha256 = ${String(r.content_sha256)}`);
      out.removed_redacted += 1;
    }

    // 2. Seals and restore records (one a day per org, never pruned). Listed page by page under
    //    the same time budget as step 3 and resumable from the last key done; only records
    //    modified since the last finished records step are stat'ed and copied (#309).
    let recordsTimeUp = false;
    if (!progress.records_done) {
      const sinceRaw = await deps.cursors.get(MIRROR_RECORDS_SINCE_KEY);
      const since = sinceRaw ? new Date(sinceRaw).getTime() : null;
      progress.records_started ??= deps.now().toISOString();
      let listed = 0;
      const startIdx = progress.records_prefix ?? 0;
      records: for (const [idx, prefix] of MIRRORED_RECORD_PREFIXES.entries()) {
        if (idx < startIdx) continue;
        let after = idx === (progress.records_prefix ?? 0) ? (progress.records_after ?? undefined) : undefined;
        for await (const page of listPages(source, prefix, deps.putTimeoutMs, after)) {
          for (const o of page) {
            if (Date.now() - started > timeBudget) {
              progress.records_prefix = idx;
              progress.records_after = after ?? null;
              recordsTimeUp = true;
              break records;
            }
            listed += 1;
            const unchanged = since !== null && o.modifiedAt && new Date(o.modifiedAt).getTime() < since;
            if (!unchanged) {
              const there = await withStorageTimeout('stat', dest.stat(o.key), deps.putTimeoutMs);
              if (!there || there.size !== o.size) {
                await copyObject(source, dest, o.key, deps.putTimeoutMs, o.size ?? 0);
                out.seals_and_records += 1;
              }
            }
            after = o.key;
          }
          deps.log.info(
            { prefix, listed, copied: out.seals_and_records },
            `bastion-mirror: records ${listed} checked this call, budget remaining ${Math.max(0, timeBudget - (Date.now() - started))} ms`,
          );
        }
      }
      if (!recordsTimeUp) {
        // Everything modified before this step began (less the clock slack) is now on the mirror.
        const mark = new Date(new Date(progress.records_started).getTime() - CURRENT_SLACK_MS);
        await deps.cursors.set(MIRROR_RECORDS_SINCE_KEY, mark.toISOString());
        progress.records_done = true;
        progress.records_prefix = undefined;
        progress.records_after = undefined;
        progress.records_started = undefined;
      }
    }

    // 3. Evidence objects not yet mirrored, fewest failed attempts first and then oldest first,
    //    within the time and per-backup budgets. The pass keeps its place across calls
    //    (`objects_after`, the last object handled), so every object, copied, missing or failed,
    //    is visited once per pass; an object whose copy failed sorts after the rest and is not
    //    tried again in this pass. One object that cannot be copied (too large for the link, say)
    //    therefore never stops the newer ones behind it (#332).
    progress.objects_started ??= deps.now().toISOString();
    const objectsStarted = new Date(progress.objects_started);
    let after: ObjectsCursor | null = progress.objects_after ?? null;
    let budgetHit = false;
    let consecutiveFailures = 0;
    let triedThisCall = 0;
    outer: for (let round = 0; !recordsTimeUp && round < 1000; round++) {
      const batch: Array<Record<string, unknown>> = await deps.sql`
        SELECT organization_id, content_sha256, object_key, size_bytes, created_at, created_at::text AS created_at_text, mirror_attempts
          FROM bastion_evidence_objects
         WHERE mirrored_at IS NULL AND bytes_redacted_at IS NULL
           AND (mirror_last_attempt_at IS NULL OR mirror_last_attempt_at < ${objectsStarted})
           ${after ? deps.sql`AND (mirror_attempts, created_at, object_key) > (${after.attempts}, ${after.created_at}::timestamptz, ${after.object_key})` : deps.sql``}
         ORDER BY mirror_attempts, created_at, object_key LIMIT 200`;
      if (batch.length === 0) break;
      for (const o of batch) {
        // Everything up to the previous object has been handled: that is where the next call resumes.
        if (after) progress.objects_after = after;
        after = { attempts: Number(o.mirror_attempts ?? 0), created_at: String(o.created_at_text), object_key: String(o.object_key) };
        if (progress.objects >= MIRROR_BUDGET_OBJECTS || progress.bytes >= MIRROR_BUDGET_BYTES) {
          budgetHit = true;
          break outer;
        }
        // At least one object per call, so a call whose budget went on steps 1 and 2 still moves on.
        if (triedThisCall > 0 && Date.now() - started > timeBudget) break outer;
        triedThisCall += 1;
        let size: number;
        try {
          size = await copyObject(source, dest, String(o.object_key), deps.putTimeoutMs, Number(o.size_bytes ?? 0));
        } catch (err) {
          const msg = (err as Error).message ?? '';
          const orgId = String(o.organization_id);
          if (isStorageNotFoundError(err) || /not found|nosuchkey/i.test(msg)) {
            // A missing source object is reported (the evidence file is gone) and skipped; the
            // pass cursor moves past it, so it is not tried again until the next pass. It says
            // nothing about the destination, so it does not count toward the failures in a row.
            out.failed += 1;
            deps.log.error({ organization_id: orgId }, 'bastion-mirror: an evidence file is missing from the Bastion bucket and could not be copied');
            continue;
          }
          // Credentials or a missing bucket: nothing can be copied, so the pass ends `failed`.
          if (isDestinationWideError(err)) throw err;
          // Anything else (a timeout, a reset upload) is recorded on this object, which then sorts
          // after every object with fewer attempts and waits for the next pass; the pass goes on.
          // Several in a row with no success between them mean the destination itself is failing,
          // and that ends the pass.
          consecutiveFailures += 1;
          out.failed += 1;
          await orgTx(deps.sql, orgId, (tx) => tx`
            UPDATE bastion_evidence_objects
               SET mirror_attempts = mirror_attempts + 1, mirror_last_error = ${msg.slice(0, 500)}, mirror_last_attempt_at = ${deps.now()}
             WHERE organization_id = ${orgId} AND content_sha256 = ${String(o.content_sha256)}`);
          deps.log.warn(
            { organization_id: orgId, size_bytes: Number(o.size_bytes ?? 0), attempts: Number(o.mirror_attempts ?? 0) + 1, err: msg },
            'bastion-mirror: one evidence file could not be copied this pass; it is skipped until the next pass and newer files go on',
          );
          if (consecutiveFailures >= MIRROR_MAX_CONSECUTIVE_FAILURES) throw err;
          continue;
        }
        consecutiveFailures = 0;
        // The bytes reached the mirror, so mirrored_at is recorded whatever happened meanwhile
        // (#310): a redaction that landed during the copy must still find this copy. When it did,
        // the copy is deleted at once; if that delete fails, step 1 retries it next pass.
        const orgId = String(o.organization_id);
        const [marked] = await orgTx(deps.sql, orgId, (tx) => tx`
          UPDATE bastion_evidence_objects SET mirrored_at = ${deps.now()}, mirror_last_error = NULL
           WHERE organization_id = ${orgId} AND content_sha256 = ${String(o.content_sha256)}
          RETURNING bytes_redacted_at`);
        if (marked?.bytes_redacted_at) {
          try {
            await withStorageTimeout('delete', dest.delete(String(o.object_key)), deps.putTimeoutMs);
            await orgTx(deps.sql, orgId, (tx) => tx`
              UPDATE bastion_evidence_objects SET mirrored_at = NULL
               WHERE organization_id = ${orgId} AND content_sha256 = ${String(o.content_sha256)}`);
            out.removed_redacted += 1;
          } catch (err) {
            deps.log.warn({ organization_id: orgId, err: (err as Error).message }, 'bastion-mirror: bytes redacted during the copy are still on the mirror; the next pass deletes them');
          }
          continue;
        }
        out.mirrored += 1;
        out.bytes += size;
        progress.objects += 1;
        progress.bytes += size;
        if (out.mirrored % 100 === 0) {
          deps.log.info(
            { mirrored: out.mirrored, bytes: out.bytes },
            `bastion-mirror: objects ${progress.objects}/${MIRROR_BUDGET_OBJECTS} this backup, budget remaining ${Math.max(0, timeBudget - (Date.now() - started))} ms`,
          );
        }
      }
    }

    const left = await unmirroredBefore(deps, horizon);
    const all = await unmirroredBefore(deps, null);
    out.remaining = all.count;
    const timeUp = Date.now() - started > timeBudget;
    let status: BastionMirrorStatus;
    let complete: boolean;
    if (!progress.records_done) {
      // The records step ran out of time: resume it on the next call.
      status = 'running';
      complete = false;
    } else if (left.count === 0) {
      status = 'completed';
      complete = true;
    } else if (budgetHit) {
      status = 'partial';
      complete = true;
    } else if (timeUp) {
      status = 'running';
      complete = false;
    } else {
      // Nothing more could be copied this pass (missing source files): current is not reached.
      status = 'partial';
      complete = true;
    }
    const cursor = left.count === 0 && progress.records_done ? horizon : left.oldest;
    out.cursor = cursor ? cursor.toISOString() : null;
    if (!(await writeMirrorStatus(deps, opts.backup_id, status, cursor, true))) {
      // The worker gave up on this call and recorded the outcome; leave its word standing.
      deps.log.warn({ backup_id: opts.backup_id ?? null, status }, 'bastion-mirror: this call finished after the backup job recorded its outcome; status left unchanged');
    }
    if (complete) await deps.cursors.set(progressKey, JSON.stringify(FRESH_PROGRESS));
    else await deps.cursors.set(progressKey, JSON.stringify(progress));
    deps.log.info(
      { backup_id: opts.backup_id ?? null, status, mirrored: out.mirrored, bytes: out.bytes, remaining: out.remaining, elapsed_ms: Date.now() - started },
      `bastion-mirror: objects ${out.mirrored} copied this call, ${out.remaining} still to copy (${status})`,
    );
    return { ...out, status, complete };
  } catch (err) {
    return fail(err);
  }
}

async function unmirroredBefore(deps: EngineDeps, before: Date | null): Promise<{ count: number; oldest: Date | null }> {
  const r = (await deps.sql`
    SELECT count(*)::int AS n, min(created_at) AS oldest FROM bastion_evidence_objects
     WHERE mirrored_at IS NULL AND bytes_redacted_at IS NULL ${before ? deps.sql`AND created_at < ${before}` : deps.sql``}`)[0];
  return { count: Number(r?.n ?? 0), oldest: r?.oldest ? new Date(r.oldest as string) : null };
}

// ── restore-objects --from-backup ────────────────────────────────────────────────────────

export interface RestoreObjectsResult {
  listed: number;
  copied: number;
  already_present: number;
  failed: number;
  /** Redacted objects the mirror still held: not copied back (and deleted if already in the bucket). */
  redacted_skipped: number;
  /** False when no database was reachable, so redacted bytes may have been copied back. */
  redaction_checked: boolean;
}

/**
 * The database's word on which objects were redacted (spec 3.4): the keys of one org whose
 * bastion_evidence_objects row has bytes_redacted_at set. Null = no database reachable.
 */
export type RedactedKeysLookup = (orgId: string) => Promise<Set<string>>;

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The org of an `evidence/<org>/...` or `manual/<org>/...` key (the prefixes redaction applies to). */
function redactableOrg(key: string): string | null {
  const [top, org] = key.split('/');
  if ((top !== 'evidence' && top !== 'manual') || !org || !UUID_SEGMENT.test(org)) return null;
  return org;
}

/**
 * Copy the off-site mirror back into the Bastion bucket (spec 9.7 runbook). Objects already
 * present with the same size are left alone, so the command is safe to run twice.
 *
 * Streams page by page (#313): each listed page is copied before the next is fetched, so memory
 * stays flat and `objects n` progress appears from the first page. A listing that fails throws
 * (the CLI exits non-zero); there is no page cap that could end the restore early and quietly.
 *
 * Redaction (#310): the mirror may still hold bytes that were redacted after its last pass, and
 * nothing would ever delete a copy put back here. With `redactedKeys` (the database), those keys
 * are never copied back, and a copy already in the bucket is deleted. Without it the result says
 * `redaction_checked: false` and the CLI tells the operator to run it again once the database is
 * back.
 */
export async function restoreObjectsFromBackup(
  mirror: StorageDriver,
  bucket: StorageDriver,
  log: (line: string) => void,
  opts: { timeoutMs?: number; dryRun?: boolean; redactedKeys?: RedactedKeysLookup | null } = {},
): Promise<RestoreObjectsResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1);
  const lookup = opts.redactedKeys ?? null;
  const res: RestoreObjectsResult = { listed: 0, copied: 0, already_present: 0, failed: 0, redacted_skipped: 0, redaction_checked: !!lookup };
  const redactedByOrg = new Map<string, Set<string>>();
  const isRedacted = async (key: string): Promise<boolean> => {
    const org = lookup ? redactableOrg(key) : null;
    if (!lookup || !org) return false;
    let set = redactedByOrg.get(org);
    if (!set) {
      set = await lookup(org);
      redactedByOrg.set(org, set);
    }
    return set.has(key);
  };
  for (const prefix of RESTORABLE_PREFIXES) {
    log(`listing ${prefix} in the off-site backup, one page at a time...`);
    let page = 0;
    for await (const objects of listPages(mirror, prefix, timeoutMs)) {
      page += 1;
      for (const o of objects) {
        res.listed += 1;
        try {
          if (await isRedacted(o.key)) {
            res.redacted_skipped += 1;
            const here = await withStorageTimeout('stat', bucket.stat(o.key), timeoutMs);
            if (here && !opts.dryRun) await withStorageTimeout('delete', bucket.delete(o.key), timeoutMs);
            continue;
          }
          const here = await withStorageTimeout('stat', bucket.stat(o.key), timeoutMs);
          if (here && here.size === o.size) {
            res.already_present += 1;
          } else {
            if (!opts.dryRun) await copyObject(mirror, bucket, o.key, timeoutMs);
            res.copied += 1;
          }
        } catch (err) {
          res.failed += 1;
          log(`could not copy one object: ${(err as Error).message}`);
        }
        if (res.listed % 50 === 0) {
          log(`objects ${res.listed} (copied ${res.copied}, already there ${res.already_present}, redacted ${res.redacted_skipped}, failed ${res.failed}) ${secs()}s`);
        }
      }
      log(`${prefix} page ${page} done: objects ${res.listed} so far, ${secs()}s`);
    }
  }
  log(`objects ${res.listed} (copied ${res.copied}, already there ${res.already_present}, redacted ${res.redacted_skipped}, failed ${res.failed}) ${secs()}s; listing complete`);
  return res;
}
