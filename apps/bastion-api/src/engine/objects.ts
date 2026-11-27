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
import type { BastionMirrorResult, BastionMirrorStatus, BastionObjectSweepResult } from '@bigbluebam/shared';
import { type EngineDeps, orgTx } from './context.js';
import { listObjects } from './restore.js';

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
const MIRROR_TIME_BUDGET_MS = 20_000;
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
}

async function copyObject(source: StorageDriver, dest: StorageDriver, key: string, timeoutMs: number): Promise<number> {
  const got = await withStorageTimeout('get', source.getStream(key), timeoutMs);
  try {
    const put = await withStorageTimeout(
      'put',
      dest.put(key, got.stream as Readable, { contentType: got.contentType, size: got.size }),
      Math.max(timeoutMs, 60_000),
    );
    return put.size || got.size;
  } catch (err) {
    (got.stream as { destroy?: () => void }).destroy?.();
    throw err;
  }
}

async function writeMirrorStatus(deps: EngineDeps, backupId: string | undefined, status: BastionMirrorStatus, cursor: Date | null): Promise<void> {
  if (!backupId) return;
  // platform_backups is platform-wide (no org column, no RLS). Only the mirror columns are
  // written: the backup's own status is never touched (spec 9.7).
  await deps.sql`UPDATE platform_backups SET bastion_mirror_status = ${status}, bastion_mirror_cursor = ${cursor}
                  WHERE id = ${backupId}`;
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
  const progress: MirrorProgress = JSON.parse((await deps.cursors.get(progressKey)) ?? '{"objects":0,"bytes":0,"records_done":false}');
  deps.log.info(
    { backup_id: opts.backup_id ?? null, objects_so_far: progress.objects, bytes_so_far: progress.bytes },
    'bastion-mirror: starting a pass to the off-site evidence backup',
  );
  if (progress.objects === 0 && progress.bytes === 0) await writeMirrorStatus(deps, opts.backup_id, 'running', null);
  const out = { ...base };
  const fail = async (err: unknown) => {
    const error = `The off-site evidence backup could not be written: ${(err as Error).message}`.slice(0, 500);
    deps.log.error({ backup_id: opts.backup_id ?? null, err: (err as Error).message }, 'bastion-mirror: pass failed; the database backup itself is unaffected');
    const remaining = await unmirroredBefore(deps, null);
    await writeMirrorStatus(deps, opts.backup_id, 'failed', remaining.oldest);
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

    // 2. Seals and restore records: few (one a day per org), compared by size, copied if missing.
    if (!progress.records_done) {
      for (const prefix of MIRRORED_RECORD_PREFIXES) {
        const objects = await listObjects(source, prefix, deps.putTimeoutMs);
        for (const [i, o] of objects.entries()) {
          const there = await withStorageTimeout('stat', dest.stat(o.key), deps.putTimeoutMs);
          if (there && there.size === o.size) continue;
          await copyObject(source, dest, o.key, deps.putTimeoutMs);
          out.seals_and_records += 1;
          if ((i + 1) % 100 === 0) deps.log.info({ prefix }, `bastion-mirror: records ${i + 1}/${objects.length}`);
        }
      }
      progress.records_done = true;
    }

    // 3. Evidence objects not yet mirrored, oldest first, within the time and per-backup budgets.
    let after: { created_at: Date; object_key: string } | null = null;
    let budgetHit = false;
    outer: for (let round = 0; round < 1000; round++) {
      const batch: Array<Record<string, unknown>> = await deps.sql`
        SELECT organization_id, content_sha256, object_key, size_bytes, created_at FROM bastion_evidence_objects
         WHERE mirrored_at IS NULL AND bytes_redacted_at IS NULL
           ${after ? deps.sql`AND (created_at, object_key) > (${after.created_at}, ${after.object_key})` : deps.sql``}
         ORDER BY created_at, object_key LIMIT 200`;
      if (batch.length === 0) break;
      for (const o of batch) {
        after = { created_at: new Date(o.created_at as string), object_key: String(o.object_key) };
        if (progress.objects >= MIRROR_BUDGET_OBJECTS || progress.bytes >= MIRROR_BUDGET_BYTES) {
          budgetHit = true;
          break outer;
        }
        if (Date.now() - started > timeBudget) break outer;
        let size: number;
        try {
          size = await copyObject(source, dest, String(o.object_key), deps.putTimeoutMs);
        } catch (err) {
          // A missing source object is reported (the evidence file is gone) and skipped; any
          // other error is the destination's or the network's, and ends the pass.
          const msg = (err as Error).message ?? '';
          if (isStorageNotFoundError(err) || /not found|nosuchkey/i.test(msg)) {
            out.failed += 1;
            deps.log.error({ organization_id: o.organization_id }, 'bastion-mirror: an evidence file is missing from the Bastion bucket and could not be copied');
            continue;
          }
          throw err;
        }
        await orgTx(deps.sql, String(o.organization_id), (tx) => tx`
          UPDATE bastion_evidence_objects SET mirrored_at = ${deps.now()}
           WHERE organization_id = ${String(o.organization_id)} AND content_sha256 = ${String(o.content_sha256)}
             AND bytes_redacted_at IS NULL`);
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
    if (left.count === 0) {
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
    const cursor = left.count === 0 ? horizon : left.oldest;
    out.cursor = cursor ? cursor.toISOString() : null;
    await writeMirrorStatus(deps, opts.backup_id, status, cursor);
    if (complete) await deps.cursors.set(progressKey, JSON.stringify({ objects: 0, bytes: 0, records_done: false }));
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
}

/**
 * Copy the off-site mirror back into the Bastion bucket (spec 9.7 runbook). Objects already
 * present with the same size are left alone, so the command is safe to run twice. Logs
 * `objects n/N` as it goes.
 */
export async function restoreObjectsFromBackup(
  mirror: StorageDriver,
  bucket: StorageDriver,
  log: (line: string) => void,
  opts: { timeoutMs?: number; dryRun?: boolean } = {},
): Promise<RestoreObjectsResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const res: RestoreObjectsResult = { listed: 0, copied: 0, already_present: 0, failed: 0 };
  const all: Array<{ key: string; size: number }> = [];
  for (const prefix of RESTORABLE_PREFIXES) {
    log(`listing ${prefix} in the off-site backup...`);
    const objects = await listObjects(mirror, prefix, timeoutMs);
    for (const o of objects) all.push({ key: o.key, size: o.size });
  }
  res.listed = all.length;
  log(`found ${all.length} objects in the off-site backup (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const [i, o] of all.entries()) {
    try {
      const here = await withStorageTimeout('stat', bucket.stat(o.key), timeoutMs);
      if (here && here.size === o.size) {
        res.already_present += 1;
      } else if (!opts.dryRun) {
        await copyObject(mirror, bucket, o.key, timeoutMs);
        res.copied += 1;
      } else {
        res.copied += 1;
      }
    } catch (err) {
      res.failed += 1;
      log(`could not copy one object: ${(err as Error).message}`);
    }
    if ((i + 1) % 50 === 0 || i + 1 === all.length) {
      log(`objects ${i + 1}/${all.length} (copied ${res.copied}, already there ${res.already_present}, failed ${res.failed}) ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  }
  return res;
}
