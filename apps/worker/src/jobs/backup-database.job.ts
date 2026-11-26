// Database backup job (Backup app, Platform scope).
//
// Runs `pg_dump -Fc` (custom compressed archive) of the whole database to a temp
// file, uploads it to object storage, and records the result on a platform_backups
// row. Both the nightly scheduled backup and the on-demand SuperUser trigger land
// here. --no-owner/--no-acl make the archive portable so it can be restored into a
// brand-new instance that does not have the same roles.

import { spawn } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { putObjectFromFile, removeObject } from '../utils/storage.js';
import type { Env } from '../env.js';

export interface BackupJobData {
  /** Pre-created platform_backups row (manual trigger from the api). Absent for the
   *  scheduled trigger, in which case the job creates the row itself. */
  backup_id?: string;
  kind: 'manual' | 'scheduled';
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Spawn pg_dump into a custom-format archive file. Rejects on non-zero exit. */
function runPgDump(databaseUrl: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pg_dump',
      ['-Fc', '--no-owner', '--no-acl', '--file', outFile, databaseUrl],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) =>
      reject(new Error(`pg_dump could not start (is postgresql-client installed?): ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 2000)}`));
    });
  });
}

/** sha256 of a file, for an integrity token independent of the storage backend. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('error', reject);
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

/** Delete completed scheduled backups beyond the retention count (newest kept). */
async function pruneOldBackups(env: Env, logger: Logger): Promise<void> {
  const db = getDb();
  const stale = rows<{ id: string; storage_key: string | null }>(
    await db.execute(sql`
      SELECT id, storage_key FROM platform_backups
      WHERE kind = 'scheduled' AND status = 'completed'
      ORDER BY created_at DESC
      OFFSET ${env.BACKUP_RETENTION_COUNT}
    `),
  );
  if (stale.length === 0) return;
  for (const b of stale) {
    try {
      if (b.storage_key) await removeObject(b.storage_key);
      await db.execute(sql`DELETE FROM platform_backups WHERE id = ${b.id}`);
    } catch (err) {
      logger.warn(
        { id: b.id, err: err instanceof Error ? err.message : String(err) },
        'backup retention prune failed for one row',
      );
    }
  }
  logger.info({ pruned: stale.length, keep: env.BACKUP_RETENTION_COUNT }, 'backup retention: pruned old scheduled backups');
}

export async function processBackupJob(
  job: Job<BackupJobData>,
  logger: Logger,
  env: Env,
): Promise<void> {
  const db = getDb();
  const start = Date.now();

  // Resolve or create the backup row (scheduled trigger has no pre-created id).
  let backupId = job.data.backup_id;
  if (!backupId) {
    const created = rows<{ id: string }>(
      await db.execute(sql`
        INSERT INTO platform_backups (kind, status, started_at)
        VALUES (${job.data.kind}, 'running', now())
        RETURNING id
      `),
    );
    backupId = created[0]?.id;
    if (!backupId) throw new Error('failed to create platform_backups row');
  } else {
    await db.execute(
      sql`UPDATE platform_backups SET status = 'running', started_at = now() WHERE id = ${backupId}`,
    );
  }

  logger.info({ backupId, kind: job.data.kind }, 'backup: starting pg_dump');

  const stamp = new Date(start).toISOString().replace(/[:.]/g, '-');
  const tmpFile = path.join(os.tmpdir(), `bbb-backup-${backupId}.dump`);
  const storageKey = `${env.BACKUP_KEY_PREFIX}/${stamp}-${backupId}.dump`;

  try {
    const verRows = rows<{ server_version: string }>(await db.execute(sql`SHOW server_version`));
    const serverVersion = verRows[0]?.server_version ?? null;

    await runPgDump(env.DATABASE_URL, tmpFile);
    const stat = await fs.stat(tmpFile);
    const integrity = await sha256File(tmpFile);
    logger.info({ backupId, bytes: stat.size, ms: Date.now() - start }, 'backup: pg_dump complete, uploading');

    await putObjectFromFile(storageKey, tmpFile, 'application/octet-stream');

    await db.execute(sql`
      UPDATE platform_backups
      SET status = 'completed', storage_key = ${storageKey}, size_bytes = ${stat.size},
          pg_version = ${serverVersion}, integrity = ${integrity}, completed_at = now()
      WHERE id = ${backupId}
    `);
    logger.info({ backupId, storageKey, ms: Date.now() - start }, 'backup: completed');

    if (job.data.kind === 'scheduled' && env.BACKUP_RETENTION_COUNT > 0) {
      await pruneOldBackups(env, logger);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ backupId, err: msg }, 'backup: failed');
    await db.execute(
      sql`UPDATE platform_backups SET status = 'failed', error = ${msg}, completed_at = now() WHERE id = ${backupId}`,
    );
    throw err;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}
