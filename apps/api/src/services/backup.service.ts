// Backup app (Platform scope) service. Enqueues whole-database backups/restores
// on the worker queues, lists/streams/deletes backups, and validates the typed
// restore confirmation phrase. SuperUser-only; gating is enforced at the route.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { enqueueBackup, enqueueRestore } from '../lib/backup-queue.js';
import { getFileStream, deleteFile } from './upload.service.js';

export interface BackupRow {
  id: string;
  scope: string;
  kind: string;
  status: string;
  storage_key: string | null;
  size_bytes: number | null;
  pg_version: string | null;
  integrity: string | null;
  triggered_by_user_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
}

export interface RestoreRow {
  id: string;
  backup_id: string | null;
  status: string;
  requested_by_user_id: string | null;
  confirmation_phrase: string | null;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

export async function listBackups(limit = 50, offset = 0): Promise<BackupRow[]> {
  return rows<BackupRow>(
    await db.execute(sql`
      SELECT id, scope, kind, status, storage_key, size_bytes, pg_version, integrity,
             triggered_by_user_id, started_at, completed_at, error, created_at
      FROM platform_backups
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
  );
}

export async function getBackup(id: string): Promise<BackupRow | null> {
  return rows<BackupRow>(await db.execute(sql`SELECT * FROM platform_backups WHERE id = ${id}`))[0] ?? null;
}

/** Create a pending manual backup row and enqueue the dump job. */
export async function createBackup(userId: string): Promise<BackupRow | null> {
  const created = rows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO platform_backups (kind, status, triggered_by_user_id)
      VALUES ('manual', 'pending', ${userId})
      RETURNING id
    `),
  );
  const id = created[0]?.id;
  if (!id) return null;
  await enqueueBackup(id);
  return getBackup(id);
}

export async function deleteBackup(id: string): Promise<boolean> {
  const b = await getBackup(id);
  if (!b) return false;
  if (b.storage_key) {
    try {
      await deleteFile(env.S3_BUCKET, b.storage_key);
    } catch {
      // Best-effort object removal; the row is deleted regardless.
    }
  }
  await db.execute(sql`DELETE FROM platform_backups WHERE id = ${id}`);
  return true;
}

// ── Download filenames ────────────────────────────────────────────────
// The object key is a machine-friendly UUID path, but the file an operator
// downloads has to explain itself sitting in a Downloads folder six months from
// now, to someone who is not a DBA: what it backs up, which site, and when.
// Deliberately plain English with a self-describing ".backup" extension - the
// archive is only ever read back by pg_restore via its storage key, so nothing
// downstream depends on this name.

// Characters Windows and macOS reject in a filename.
const FILENAME_ILLEGAL = /[<>:"/\\|?*]/g;

function sanitizeFilenamePart(raw: string): string {
  const printable = raw
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('');
  return printable.replace(FILENAME_ILLEGAL, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Which deployment this archive came from, e.g. "bigbluebam.com" or "localhost". */
function deploymentLabel(): string {
  const raw = (env as { PUBLIC_URL?: string }).PUBLIC_URL ?? '';
  let host = raw;
  try {
    host = new URL(raw).hostname || raw;
  } catch {
    // PUBLIC_URL is not a parseable URL; fall back to whatever it is.
  }
  return sanitizeFilenamePart(host) || 'this site';
}

/** "2026-07-22 1940 UTC" - sorts chronologically and still reads as a date. */
function humanStamp(iso: string | null): string {
  const parsed = iso ? new Date(iso) : new Date();
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())} UTC`
  );
}

/** How a scope reads in a filename. Organization/Project are the deferred levels. */
function scopeLabel(scope: string, subject: string | null): string {
  const named = subject ? sanitizeFilenamePart(subject) : '';
  if (scope === 'organization' || scope === 'org') {
    return named ? `Organization ${named}` : 'One Organization';
  }
  if (scope === 'project') return named ? `Project ${named}` : 'One Project';
  return 'Entire Site';
}

/**
 * The human-facing download name, e.g.
 *   "BigBlueBam Backup - Entire Site - bigbluebam.com - 2026-07-22 1940 UTC.backup"
 */
export function backupDownloadFilename(
  b: Pick<BackupRow, 'scope' | 'created_at' | 'completed_at'> & { scope_subject?: string | null },
): string {
  const parts = [
    'BigBlueBam Backup',
    scopeLabel(b.scope || 'platform', b.scope_subject ?? null),
    deploymentLabel(),
    humanStamp(b.completed_at ?? b.created_at),
  ];
  return `${parts.join(' - ')}.backup`;
}

/** Stream a completed backup archive for download through the api. */
export async function getBackupStream(
  id: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number; filename: string } | null> {
  const b = await getBackup(id);
  if (!b?.storage_key || b.status !== 'completed') return null;
  const { stream, size } = await getFileStream(env.S3_BUCKET, b.storage_key);
  return { stream, size, filename: backupDownloadFilename(b) };
}

/** The exact phrase a SuperUser must type to authorize restoring this backup. */
export function restoreConfirmationPhrase(backupId: string): string {
  return `RESTORE ${backupId.slice(0, 8)}`;
}

export type RestoreRequestResult =
  | { ok: true; restoreId: string }
  | { ok: false; reason: 'backup_not_restorable' | 'phrase_mismatch' };

export async function requestRestore(
  backupId: string,
  userId: string,
  phrase: string,
): Promise<RestoreRequestResult> {
  const b = await getBackup(backupId);
  if (!b || b.status !== 'completed' || !b.storage_key) {
    return { ok: false, reason: 'backup_not_restorable' };
  }
  if (phrase.trim() !== restoreConfirmationPhrase(backupId)) {
    return { ok: false, reason: 'phrase_mismatch' };
  }
  const created = rows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO platform_restores (backup_id, status, requested_by_user_id, confirmation_phrase)
      VALUES (${backupId}, 'pending', ${userId}, ${phrase})
      RETURNING id
    `),
  );
  const id = created[0]?.id;
  if (!id) return { ok: false, reason: 'backup_not_restorable' };
  await enqueueRestore(id);
  return { ok: true, restoreId: id };
}

export async function listRestores(limit = 50): Promise<RestoreRow[]> {
  return rows<RestoreRow>(
    await db.execute(sql`
      SELECT id, backup_id, status, requested_by_user_id, confirmation_phrase,
             started_at, completed_at, error, created_at
      FROM platform_restores
      ORDER BY created_at DESC
      LIMIT ${limit}
    `),
  );
}
