// Database restore job (Backup app, Platform scope).
//
// Restores a whole-database pg_dump archive by the ONLY approach that is both
// correct and safe for this schema:
//
//   1. Restore the archive into a fresh TEMPORARY database (pg_restore into an
//      empty db - no --clean, so a successful restore exits 0 cleanly).
//   2. Only if that fully succeeds, atomically swap it in: DROP the live database
//      WITH (FORCE) (terminates connections) and RENAME the temp db into its place.
//
// Why not `pg_restore --clean --if-exists` in place: this schema has enum types
// that columns depend on and partitioned/inherited tables, so --clean cannot drop
// them in dependency order. The DROPs fail, the CREATEs then collide ("already
// exists"), and data COPY hits duplicate keys - leaving a corrupt half-restore.
// Restore-into-temp-then-swap also means a bad/corrupt archive can NEVER destroy
// the live database: if step 1 fails, the live db is untouched and we mark the
// restore failed.
//
// This is DESTRUCTIVE and disruptive: the live database is dropped and replaced,
// so connected clients are cut off. Authorization (SuperUser + a typed
// confirmation phrase) is enforced by the api before this job is enqueued.
//
// Tracking note: a whole-database restore replaces platform_restores too, so the
// original 'running' row lives in the pre-swap database and is gone after the
// swap. On success we write a fresh 'completed' marker row into the restored
// database; on failure the original row (still in the intact live db) is marked
// 'failed'.

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

/** Derive the admin (maintenance-db) URL, target db name, and a temp db name/URL. */
function planUrls(databaseUrl: string, restoreId: string) {
  const target = new URL(databaseUrl);
  const targetDb = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const tmpDb = `${targetDb}_restore_${restoreId.slice(0, 8)}`;

  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';

  const tmp = new URL(databaseUrl);
  tmp.pathname = `/${tmpDb}`;

  return { adminUrl: admin.toString(), targetDb, tmpDb, tmpUrl: tmp.toString() };
}

/** Run one SQL statement via psql against a maintenance connection. Rejects non-zero. */
function runPsql(url: string, statement: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', statement], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) =>
      reject(new Error(`psql could not start (is postgresql-client installed?): ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql exited ${code} for [${statement.slice(0, 60)}...]: ${stderr.slice(0, 1500)}`));
    });
  });
}

/** Restore an archive into an (empty) target database. Rejects non-zero. */
function runPgRestore(databaseUrl: string, inFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pg_restore',
      ['--no-owner', '--no-acl', '--dbname', databaseUrl, inFile],
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

  const found = rows<{ storage_key: string | null; backup_id: string | null }>(
    await db.execute(sql`
      SELECT b.storage_key, r.backup_id
      FROM platform_restores r
      LEFT JOIN platform_backups b ON b.id = r.backup_id
      WHERE r.id = ${restore_id}
    `),
  );
  const storageKey = found[0]?.storage_key ?? null;
  const backupId = found[0]?.backup_id ?? null;
  if (!storageKey) {
    await db.execute(
      sql`UPDATE platform_restores SET status = 'failed', error = 'backup archive not found', completed_at = now() WHERE id = ${restore_id}`,
    );
    throw new Error(`restore ${restore_id}: backup archive not found`);
  }

  await db.execute(
    sql`UPDATE platform_restores SET status = 'running', started_at = now() WHERE id = ${restore_id}`,
  );

  const { adminUrl, targetDb, tmpDb, tmpUrl } = planUrls(env.DATABASE_URL, restore_id);
  const tmpFile = path.join(os.tmpdir(), `bbb-restore-${restore_id}.dump`);
  logger.warn({ restore_id, targetDb, tmpDb }, 'restore: starting (restore-into-temp, then swap). DESTRUCTIVE.');

  // ── Phase 1: restore into a fresh temp database. The live db is untouched here,
  // so any failure is safe - we mark the (still-present) restore row failed. ──
  try {
    const ok = await downloadObjectToFile(storageKey, tmpFile);
    if (!ok) throw new Error(`could not download backup archive ${storageKey}`);

    // Fresh temp db (drop any leftover from a previous attempt first).
    await runPsql(adminUrl, `DROP DATABASE IF EXISTS "${tmpDb}" WITH (FORCE)`);
    await runPsql(adminUrl, `CREATE DATABASE "${tmpDb}"`);
    logger.info({ restore_id, tmpDb, ms: Date.now() - start }, 'restore: temp db created, restoring archive into it');

    await runPgRestore(tmpUrl, tmpFile);
    logger.info({ restore_id, ms: Date.now() - start }, 'restore: archive restored into temp db, swapping in');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ restore_id, err: msg }, 'restore: failed before swap (live database untouched)');
    // Best-effort cleanup of the temp db; the live db and its restore row are intact.
    await runPsql(adminUrl, `DROP DATABASE IF EXISTS "${tmpDb}" WITH (FORCE)`).catch(() => {});
    await db.execute(
      sql`UPDATE platform_restores SET status = 'failed', error = ${msg}, completed_at = now() WHERE id = ${restore_id}`,
    );
    await fs.rm(tmpFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }

  // ── Phase 2: atomic swap. The temp db is a verified good restore; make it live. ──
  // After this point the original restore row is gone (it lived in the pre-swap db).
  try {
    await runPsql(adminUrl, `DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
    await runPsql(adminUrl, `ALTER DATABASE "${tmpDb}" RENAME TO "${targetDb}"`);
    logger.info({ restore_id, ms: Date.now() - start }, 'restore: swap complete, database restored');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A failure DURING the swap is the dangerous window; log loudly. The temp db
    // holds a good restore - an operator can finish the rename by hand.
    logger.error(
      { restore_id, err: msg, tmpDb, targetDb },
      'restore: SWAP FAILED - a good restore exists in the temp db; complete the rename manually',
    );
    throw err;
  }

  // Best-effort completion marker in the now-restored database (getDb reconnects to the
  // same DATABASE_URL, which now points at the restored db). The swap already succeeded,
  // so a marker hiccup must NOT fail the restore.
  try {
    await getDb().execute(sql`
      INSERT INTO platform_restores (backup_id, status, requested_by_user_id, confirmation_phrase, started_at, completed_at)
      VALUES (${backupId}, 'completed', NULL, ${`restore ${restore_id} (marker re-created after whole-db swap)`}, now(), now())
    `);
  } catch (err) {
    logger.warn(
      { restore_id, err: err instanceof Error ? err.message : String(err) },
      'restore: swap succeeded but writing the completion marker failed (restore is complete regardless)',
    );
  }
}
