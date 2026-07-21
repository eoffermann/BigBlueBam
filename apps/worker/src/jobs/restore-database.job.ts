// Database restore job (Backup app, Platform scope).
//
// Fetches a pg_dump archive from object storage and runs `pg_restore --clean
// --if-exists` against the target database, then records the outcome on the
// platform_restores row. This is DESTRUCTIVE: --clean drops existing objects
// before recreating them. Authorization (SuperUser + a typed confirmation phrase)
// is enforced by the api before this job is ever enqueued.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { downloadObjectToFile } from '../utils/storage.js';
import type { Env } from '../env.js';

export interface RestoreJobData {
  /** platform_restores row id (created by the api once the confirmation phrase matched). */
  restore_id: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Spawn pg_restore against the target database. Rejects on non-zero exit. */
function runPgRestore(databaseUrl: string, inFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pg_restore',
      ['--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', databaseUrl, inFile],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) =>
      reject(new Error(`pg_restore could not start (is postgresql-client installed?): ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited ${code}: ${stderr.slice(0, 4000)}`));
    });
  });
}

export async function processRestoreJob(
  job: Job<RestoreJobData>,
  logger: Logger,
  env: Env,
): Promise<void> {
  const db = getDb();
  const { restore_id } = job.data;
  const start = Date.now();

  const found = rows<{ storage_key: string | null }>(
    await db.execute(sql`
      SELECT b.storage_key
      FROM platform_restores r
      LEFT JOIN platform_backups b ON b.id = r.backup_id
      WHERE r.id = ${restore_id}
    `),
  );
  const storageKey = found[0]?.storage_key ?? null;
  if (!storageKey) {
    await db.execute(
      sql`UPDATE platform_restores SET status = 'failed', error = 'backup archive not found', completed_at = now() WHERE id = ${restore_id}`,
    );
    throw new Error(`restore ${restore_id}: backup archive not found`);
  }

  await db.execute(
    sql`UPDATE platform_restores SET status = 'running', started_at = now() WHERE id = ${restore_id}`,
  );
  logger.warn({ restore_id, storageKey }, 'restore: starting DESTRUCTIVE pg_restore (--clean --if-exists)');

  const tmpFile = path.join(os.tmpdir(), `bbb-restore-${restore_id}.dump`);
  try {
    const ok = await downloadObjectToFile(storageKey, tmpFile);
    if (!ok) throw new Error(`could not download backup archive ${storageKey}`);
    logger.info({ restore_id, ms: Date.now() - start }, 'restore: archive downloaded, restoring');

    await runPgRestore(env.DATABASE_URL, tmpFile);

    await db.execute(
      sql`UPDATE platform_restores SET status = 'completed', completed_at = now() WHERE id = ${restore_id}`,
    );
    logger.info({ restore_id, ms: Date.now() - start }, 'restore: completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ restore_id, err: msg }, 'restore: failed');
    await db.execute(
      sql`UPDATE platform_restores SET status = 'failed', error = ${msg}, completed_at = now() WHERE id = ${restore_id}`,
    );
    throw err;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
}
