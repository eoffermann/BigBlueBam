/**
 * Blank submission file-processing sweep.
 *
 * Picks up submissions where `file_processing_status = 'pending'` and processes
 * their uploaded attachments for real:
 *
 *   1. Each attachment descriptor (written by the blank-api public upload
 *      endpoint) carries a `storage_key` pointing at an object in MinIO.
 *   2. We stat the object to confirm it actually landed and read its real size.
 *   3. We validate the filename extension + declared content-type against the
 *      allowlist (SVG and unknown types are rejected).
 *   4. We record the canonical object key, an app-served download path, and a
 *      24h presigned URL on `processed_files` so the responses UI can link to
 *      the stored file.
 *
 * On any rejection (disallowed type, MIME mismatch, missing object) the
 * submission flips to `failed` with a human-readable `file_processing_error`;
 * otherwise it flips to `completed`.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { statObject, presignedGetUrl } from '../utils/storage.js';

export interface BlankFileProcessJobData {
  /** Optional: scope to a single submission for targeted runs. */
  submission_id?: string;
  /** Max rows per sweep. Defaults to 50. */
  limit?: number;
  /**
   * Force every row to succeed regardless of the random failure roll.
   * Useful in tests. Defaults to false.
   */
  forceSuccess?: boolean;
}

interface PendingSubmissionRow {
  id: string;
  attachments: unknown;
}

// ---------------------------------------------------------------------------
// Allowed file extension -> MIME type mapping for content-type validation
// ---------------------------------------------------------------------------

const ALLOWED_FILE_TYPES: Record<string, string[]> = {
  // Images
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.heic': ['image/heic'],
  '.heif': ['image/heif'],
  // Documents
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.csv': ['text/csv', 'application/csv'],
  '.txt': ['text/plain'],
  // Archive
  '.zip': ['application/zip'],
};

interface AttachmentDescriptor {
  field_key?: string | null;
  filename?: string | null;
  content_type?: string | null;
  mimetype?: string | null;
  size?: number | null;
  storage_key?: string | null;
}

interface ProcessedFile {
  field_key: string | null;
  filename: string;
  storage_key: string | null;
  /** App-served, org-scoped proxy path; null if the object never landed. */
  url: string | null;
  /** Short-lived presigned direct URL; null if minting failed. */
  download_url: string | null;
  size_bytes: number;
  content_type: string | null;
  scan_result: 'clean' | 'rejected';
  rejection_reason: string | null;
  scanned_at: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Validate + verify a single stored attachment. Stats the MinIO object to
 * confirm it landed, checks the filename extension and declared MIME against
 * the allowlist, and produces the processed-file record (with download URLs).
 */
async function processAttachment(
  submissionId: string,
  entry: AttachmentDescriptor,
  idx: number,
): Promise<ProcessedFile> {
  const name = str(entry.filename) ?? `attachment_${idx}`;
  const fieldKey = str(entry.field_key) ?? null;
  const declaredType = str(entry.content_type) ?? str(entry.mimetype) ?? null;
  const storageKey = str(entry.storage_key) ?? null;
  const scannedAt = new Date().toISOString();

  const reject = (reason: string, size = 0): ProcessedFile => ({
    field_key: fieldKey,
    filename: name,
    storage_key: storageKey,
    url: null,
    download_url: null,
    size_bytes: size,
    content_type: declaredType,
    scan_result: 'rejected',
    rejection_reason: reason,
    scanned_at: scannedAt,
  });

  // Extension allowlist check.
  const dotIdx = name.lastIndexOf('.');
  const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : '';
  const allowedMimes = ALLOWED_FILE_TYPES[ext];
  if (!allowedMimes) {
    return reject(`Unsupported file extension: ${ext || '(none)'}`);
  }

  // Declared MIME cross-check.
  if (declaredType && !allowedMimes.includes(declaredType.split(';')[0]!.trim().toLowerCase())) {
    return reject(`MIME type mismatch: declared ${declaredType} but extension is ${ext}`);
  }

  // The object must actually exist in storage. A descriptor without a
  // storage_key is metadata-only (legacy / filename-only submissions) and
  // cannot be served — reject it so operators notice the gap.
  if (!storageKey) {
    return reject('No stored object for this attachment (storage_key missing)');
  }

  const stat = await statObject(storageKey);
  if (!stat) {
    return reject(`Stored object not found in storage: ${storageKey}`);
  }

  const downloadUrl = await presignedGetUrl(storageKey);

  return {
    field_key: fieldKey,
    filename: name,
    storage_key: storageKey,
    // App-served, org-scoped proxy path through blank-api. The index lets the
    // route resolve which processed_files entry to stream.
    url: `/blank/api/v1/submissions/${submissionId}/files/${idx}`,
    download_url: downloadUrl,
    size_bytes: stat.size,
    content_type: stat.contentType ?? declaredType ?? allowedMimes[0]!,
    scan_result: 'clean',
    rejection_reason: null,
    scanned_at: scannedAt,
  };
}

async function processAttachments(
  submissionId: string,
  attachments: unknown,
): Promise<{ files: ProcessedFile[]; scanned_at: string; all_clean: boolean }> {
  const scanned_at = new Date().toISOString();
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { files: [], scanned_at, all_clean: true };
  }

  const files: ProcessedFile[] = [];
  for (let idx = 0; idx < attachments.length; idx += 1) {
    files.push(
      await processAttachment(submissionId, attachments[idx] as AttachmentDescriptor, idx),
    );
  }
  const all_clean = files.every((f) => f.scan_result === 'clean');
  return { files, scanned_at, all_clean };
}

async function advanceSubmission(
  row: PendingSubmissionRow,
  _forceSuccess: boolean,
  logger: Logger,
): Promise<'completed' | 'failed'> {
  const db = getDb();

  const result = await processAttachments(row.id, row.attachments);

  if (!result.all_clean) {
    const rejectedFiles = result.files.filter((f) => f.scan_result === 'rejected');
    const errorMessage = rejectedFiles
      .map((f) => `${f.filename}: ${f.rejection_reason}`)
      .join('; ');

    await db.execute(sql`
      UPDATE blank_submissions
      SET
        file_processing_status = 'failed',
        file_processing_error = ${errorMessage.slice(0, 500)},
        processed_files = ${JSON.stringify(result)}::jsonb
      WHERE id = ${row.id}
    `);
    logger.info(
      { submissionId: row.id, rejectedCount: rejectedFiles.length },
      'blank-file-process: files rejected by validation',
    );
    return 'failed';
  }

  await db.execute(sql`
    UPDATE blank_submissions
    SET
      file_processing_status = 'completed',
      file_processing_error = NULL,
      processed_files = ${JSON.stringify(result)}::jsonb
    WHERE id = ${row.id}
  `);
  logger.debug(
    { submissionId: row.id, fileCount: result.files.length },
    'blank-file-process: all files validated and verified in storage',
  );
  return 'completed';
}

export async function processBlankFileProcessJob(
  job: Job<BlankFileProcessJobData>,
  logger: Logger,
): Promise<void> {
  const { submission_id, limit, forceSuccess } = job.data ?? {};
  const cap = limit ?? 50;
  const db = getDb();

  let rows: PendingSubmissionRow[];
  if (submission_id) {
    const rowsRaw = await db.execute(sql`
      SELECT id, attachments FROM blank_submissions
      WHERE id = ${submission_id} AND file_processing_status = 'pending'
      LIMIT 1
    `);
    rows = (
      Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? [])
    ) as PendingSubmissionRow[];
  } else {
    const rowsRaw = await db.execute(sql`
      SELECT id, attachments FROM blank_submissions
      WHERE file_processing_status = 'pending'
      ORDER BY submitted_at ASC
      LIMIT ${cap}
    `);
    rows = (
      Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? [])
    ) as PendingSubmissionRow[];
  }

  if (rows.length === 0) {
    logger.debug('blank-file-process: no pending submissions');
    return;
  }

  logger.info({ jobId: job.id, candidates: rows.length }, 'blank-file-process: sweep start');

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const outcome = await advanceSubmission(row, forceSuccess ?? false, logger);
      if (outcome === 'completed') processed += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        {
          submissionId: row.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'blank-file-process: unexpected error',
      );
    }
  }

  logger.info(
    { jobId: job.id, candidates: rows.length, processed, failed },
    'blank-file-process: sweep complete',
  );
}
