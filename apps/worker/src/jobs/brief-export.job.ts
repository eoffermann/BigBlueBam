/**
 * Brief document export job.
 *
 * Generates export files (Markdown, HTML, or PDF placeholder) for Brief
 * documents on demand. The export is stored in MinIO/S3 and the download
 * URL is recorded so the Brief SPA can poll for it.
 *
 * Triggered by the export routes when a user requests an async export of
 * a large document or batch of documents. Not scheduled; processed on
 * demand from the 'brief-export' queue.
 *
 * Bolt event: `document.exported` with source `'brief'`.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';
import { isWorkerStorageConfigured, putObjectBuffer, workerStorageEnv } from '../utils/storage.js';

export interface BriefExportJobData {
  document_id: string;
  org_id: string;
  user_id: string;
  format: 'markdown' | 'html' | 'pdf';
}

interface DocumentRow {
  id: string;
  org_id: string;
  title: string;
  slug: string;
  plain_text: string | null;
  html_snapshot: string | null;
}

async function fetchDocument(
  documentId: string,
  orgId: string,
): Promise<DocumentRow | null> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT id, org_id, title, slug, plain_text, html_snapshot
    FROM brief_documents
    WHERE id = ${documentId}
      AND org_id = ${orgId}
      AND archived_at IS NULL
    LIMIT 1
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as DocumentRow) ?? null;
}

function generateMarkdown(doc: DocumentRow): string {
  // plain_text is the authoritative markdown content
  const body = doc.plain_text ?? '';
  return `# ${doc.title}\n\n${body}`;
}

function generateHtml(doc: DocumentRow): string {
  const body = doc.html_snapshot ?? `<p>${doc.plain_text ?? ''}</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(doc.title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1 { border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
    code { background: #f3f4f6; padding: 0.15em 0.3em; border-radius: 3px; }
    pre code { display: block; padding: 1rem; overflow-x: auto; }
    blockquote { border-left: 3px solid #d1d5db; margin-left: 0; padding-left: 1rem; color: #6b7280; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem; text-align: left; }
    th { background: #f9fafb; }
  </style>
</head>
<body>
  <h1>${escapeHtml(doc.title)}</h1>
  ${body}
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function processBriefExportJob(
  job: Job<BriefExportJobData>,
  logger: Logger,
): Promise<void> {
  const { document_id, org_id, user_id, format } = job.data;
  logger.info({ jobId: job.id, document_id, format }, 'brief-export: start');

  const doc = await fetchDocument(document_id, org_id);
  if (!doc) {
    logger.warn({ document_id, org_id }, 'brief-export: document not found or archived');
    return;
  }

  let content: string;
  let mimeType: string;
  let extension: string;

  switch (format) {
    case 'markdown':
      content = generateMarkdown(doc);
      mimeType = 'text/markdown';
      extension = 'md';
      break;
    case 'html':
      content = generateHtml(doc);
      mimeType = 'text/html';
      extension = 'html';
      break;
    case 'pdf':
      // PDF generation is a placeholder. A real implementation would use
      // a headless browser or PDF library. For now, generate HTML and
      // note that the caller should convert.
      content = generateHtml(doc);
      mimeType = 'text/html';
      extension = 'html';
      logger.info(
        { document_id },
        'brief-export: PDF not yet implemented, falling back to HTML',
      );
      break;
    default:
      logger.warn({ format }, 'brief-export: unsupported format');
      return;
  }

  // If object storage is configured, upload the export through the worker's
  // @bigbluebam/storage driver (issue #176: no private client, no default
  // credentials). Otherwise, log the export details. The caller can poll the
  // job result for the download URL.
  let downloadUrl: string | null = null;

  if (isWorkerStorageConfigured()) {
    try {
      const { S3_BUCKET: bucket } = workerStorageEnv();
      const objectKey = `exports/${org_id}/${document_id}/${Date.now()}.${extension}`;
      await putObjectBuffer(objectKey, Buffer.from(content), mimeType);

      downloadUrl = `/${bucket}/${objectKey}`;
      logger.info({ document_id, objectKey }, 'brief-export: uploaded to S3');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'brief-export: S3 upload failed, export content lost',
      );
    }
  } else {
    logger.info(
      { document_id, format, bytes: content.length },
      'brief-export: S3 not configured, export generated but not stored',
    );
  }

  await publishBoltEvent(
    'document.exported',
    'brief',
    {
      document_id,
      format,
      bytes: content.length,
      download_url: downloadUrl,
    },
    org_id,
    user_id,
    'user',
  );

  logger.info({ jobId: job.id, document_id, format }, 'brief-export: complete');
}
