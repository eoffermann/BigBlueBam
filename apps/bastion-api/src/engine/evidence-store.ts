// Manual-evidence bytes and the re-evaluations their changes trigger (spec 3.3, 3.4).
//
// Copy at attach: the pinned Bin version (or a written statement) is streamed into Bastion's own
// bucket under a RANDOM key, hashed as it goes. The bastion_object_intents row is committed BEFORE
// the put, and deleted in the same transaction that inserts (or reference-counts) the
// bastion_evidence_objects row, so the object sweep (M9) can reconcile any put whose row never
// landed. Objects are content-addressed per org: identical bytes uploaded twice share one row
// (holder_count + 1) and the second random-key copy is deleted after commit.

import { createHash, randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { withStorageTimeout, type StorageDriver } from '@bigbluebam/storage';
import { ConflictError, UnavailableError } from '../lib/errors.js';
import { type EngineDeps, orgTx, type Tx } from './context.js';

export const MANUAL_OBJECT_PREFIX = 'manual';
/** Largest single manual-evidence file Bastion will copy (Bin's own cap is larger). */
export const MAX_MANUAL_EVIDENCE_BYTES = 100 * 1024 * 1024;
/** Copying a large file can take longer than a probe write; still bounded. */
const COPY_TIMEOUT_MS = 120_000;

export interface StoredBytes {
  object_key: string;
  content_sha256: string;
  size_bytes: number;
  content_type: string;
}

const STORAGE_DOWN = "Evidence storage isn't reachable right now, so nothing was saved. Try again in a few minutes.";

async function writeIntent(deps: EngineDeps, orgId: string, key: string): Promise<void> {
  await orgTx(deps.sql, orgId, (tx) => tx`
    INSERT INTO bastion_object_intents (organization_id, object_key) VALUES (${orgId}, ${key})
    ON CONFLICT (object_key) DO NOTHING`);
}

/** Put a small in-memory body (a written statement). */
export async function storeBuffer(deps: EngineDeps, orgId: string, body: Buffer, contentType: string): Promise<StoredBytes> {
  if (!deps.storage) throw new UnavailableError("Evidence storage isn't set up on this installation, so evidence can't be saved yet.", 'STORAGE_NOT_SET_UP');
  const key = `${MANUAL_OBJECT_PREFIX}/${orgId}/${randomUUID()}`;
  await writeIntent(deps, orgId, key);
  try {
    await withStorageTimeout('put', deps.storage.put(key, body, { contentType, size: body.length }), deps.putTimeoutMs);
  } catch {
    throw new UnavailableError(STORAGE_DOWN, 'STORAGE_UNAVAILABLE');
  }
  return { object_key: key, content_sha256: createHash('sha256').update(body).digest('hex'), size_bytes: body.length, content_type: contentType };
}

/** Stream one pinned Bin object into Bastion's bucket, hashing as it goes. */
export async function copyFromBin(
  deps: EngineDeps,
  binStorage: StorageDriver | null,
  orgId: string,
  source: { object_key: string; size: number; content_type: string },
): Promise<StoredBytes> {
  if (!deps.storage) throw new UnavailableError("Evidence storage isn't set up on this installation, so evidence can't be saved yet.", 'STORAGE_NOT_SET_UP');
  if (!binStorage) throw new UnavailableError("Bastion can't read files from Bin on this installation (storage isn't set up).", 'BIN_STORAGE_NOT_SET_UP');
  if (source.size > MAX_MANUAL_EVIDENCE_BYTES) {
    throw new ConflictError('That file is larger than 100 MB. Upload a smaller export, or split it into parts.', 'EVIDENCE_TOO_LARGE');
  }
  const key = `${MANUAL_OBJECT_PREFIX}/${orgId}/${randomUUID()}`;
  await writeIntent(deps, orgId, key);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const { stream } = await withStorageTimeout('get', binStorage.getStream(source.object_key), deps.putTimeoutMs);
    const pass = new PassThrough();
    (stream as NodeJS.ReadableStream).on('data', (chunk: Buffer | string) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(b);
      size += b.length;
    });
    (stream as NodeJS.ReadableStream).on('error', (err) => pass.destroy(err));
    (stream as NodeJS.ReadableStream).pipe(pass);
    await withStorageTimeout('put', deps.storage.put(key, pass, { contentType: source.content_type, size: source.size }), COPY_TIMEOUT_MS);
  } catch {
    throw new UnavailableError(STORAGE_DOWN, 'STORAGE_UNAVAILABLE');
  }
  return { object_key: key, content_sha256: hash.digest('hex'), size_bytes: size, content_type: source.content_type };
}

/**
 * Record the bytes in the same transaction as their holder. Returns the object key the holder
 * should read and, when the bytes already existed, the duplicate key to delete after commit (its
 * intent row stays until that delete succeeds, so the sweep finds it if the delete fails).
 */
export async function recordObject(tx: Tx, orgId: string, stored: StoredBytes): Promise<{ object_key: string; duplicate_key: string | null }> {
  const existing = (await tx`
    SELECT object_key, bytes_redacted_at FROM bastion_evidence_objects
     WHERE organization_id = ${orgId} AND content_sha256 = ${stored.content_sha256} FOR UPDATE`)[0];
  if (existing?.bytes_redacted_at) {
    throw new ConflictError('These exact bytes were redacted earlier and cannot be uploaded again as evidence.', 'BYTES_REDACTED');
  }
  if (existing) {
    await tx`UPDATE bastion_evidence_objects SET holder_count = holder_count + 1
              WHERE organization_id = ${orgId} AND content_sha256 = ${stored.content_sha256}`;
    return { object_key: existing.object_key as string, duplicate_key: stored.object_key };
  }
  await tx`
    INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, content_type, holder_count)
    VALUES (${orgId}, ${stored.content_sha256}, ${stored.object_key}, ${stored.size_bytes}, ${stored.content_type}, 1)`;
  await tx`DELETE FROM bastion_object_intents WHERE object_key = ${stored.object_key}`;
  return { object_key: stored.object_key, duplicate_key: null };
}

/** After commit: remove a duplicate copy, then its intent row. Failures leave the intent for the sweep. */
export async function dropDuplicate(deps: EngineDeps, orgId: string, key: string | null): Promise<void> {
  if (!key || !deps.storage) return;
  try {
    await withStorageTimeout('delete', deps.storage.delete(key), deps.putTimeoutMs);
    await orgTx(deps.sql, orgId, (tx) => tx`DELETE FROM bastion_object_intents WHERE object_key = ${key}`);
  } catch (err) {
    deps.log.warn({ organization_id: orgId, err: (err as Error).message }, 'bastion-evidence: duplicate copy not removed; the object sweep will');
  }
}

/** After a write whose bytes never got a holder (the transaction failed): best-effort cleanup. */
export async function abandonStored(deps: EngineDeps, orgId: string, stored: StoredBytes | null): Promise<void> {
  if (stored) await dropDuplicate(deps, orgId, stored.object_key);
}

// ── Re-evaluation of the controls a change touches ───────────────────────────────────────

export interface QueuedRun {
  organization_id: string;
  run_id: string;
  resume_count: number;
}

/**
 * Queue a control-scope evaluation run for each control (spec 3.3: a review, withdrawal,
 * redaction or expiry re-evaluates linked controls). A control that already has a live control
 * run is skipped (the partial unique index); that run picks the change up. Returns the new runs
 * for the caller to enqueue AFTER commit; the evaluate tick re-enqueues any queued run that was
 * not, so a dropped enqueue only delays the re-evaluation.
 */
export async function queueControlRuns(
  tx: Tx,
  orgId: string,
  controlIds: Iterable<string>,
  now: Date,
  startedBy: string | null,
  trigger: 'manual' | 'agent' = 'manual',
): Promise<QueuedRun[]> {
  const out: QueuedRun[] = [];
  for (const controlId of new Set(controlIds)) {
    const rows = await tx`
      INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, control_id, as_of, status, started_by)
      VALUES (${orgId}, ${trigger}, 'control', ${controlId}, ${now}, 'queued', ${startedBy})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (rows[0]) out.push({ organization_id: orgId, run_id: rows[0].id as string, resume_count: 0 });
  }
  return out;
}

/** The controls whose manual assertions link this evidence (live links only). */
export async function controlsLinkedTo(tx: Tx, orgId: string, manualEvidenceId: string): Promise<string[]> {
  const rows = await tx`
    SELECT DISTINCT a.control_id
      FROM bastion_manual_evidence_links l
      JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
     WHERE l.organization_id = ${orgId} AND l.manual_evidence_id = ${manualEvidenceId} AND l.unlinked_at IS NULL`;
  return rows.map((r) => r.control_id as string);
}
