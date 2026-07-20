/**
 * Bursar scope-derivation driver (spec 3.2). Event-driven queue consumer, enqueued by
 * bursar-api's POST /v1/requests/:id/derive-scope. The worker REGISTRATION lands in M8; this
 * file is the thin driver it will register.
 *
 * The job resolves the request's source text - inline `source_text` from the job payload, or the
 * PINNED Bin version's bytes it reads itself (spec 5.8 read-time re-assertion: org + scan_status
 * clean) and best-effort text-extracts - then POLLS bursar-api's async-start engine one chunk per
 * call until the run is `done`. Bounded to one chunk per invocation is enforced server-side; the
 * poll loop here just re-drives the same run_id. A 409 (claimed by another worker) or a lost run
 * ends this attempt; the reaper recovers a wedged run.
 *
 * Progress logging before the byte read, before each poll, with elapsed-ms context (flushed by
 * pino).
 */
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BursarDeriveScopeJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { getObjectBuffer } from '../utils/storage.js';
import { postBursar } from './bursar-shared.js';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// Best-effort text extraction (same shape as burn-extract): plain text decodes directly; a PDF
// text layer is approximated from parenthesized show-operator strings (Tj/TJ). An image-only scan
// yields ~empty text and the engine surfaces zero nodes (no OCR in v1).
function extractText(buf: Buffer, contentType: string | null): string {
  const isPdf = (contentType ?? '').includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) return buf.toString('utf8');
  const latin = buf.toString('latin1');
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*T[jJ]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const s = (m[1] ?? '').replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    if (s.trim()) out.push(s);
  }
  return out.join('\n');
}

const MAX_POLLS = 500; // hard cap so a bug cannot spin forever; a real doc chunks well under this.

export async function processBursarDeriveScopeJob(
  job: Job<BursarDeriveScopeJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id, request_id, run_id } = job.data;
  const started = Date.now();
  const claimant = `worker:${job.id ?? 'unknown'}`;
  logger.info({ jobId: job.id, organization_id, request_id, run_id, attempt: job.attemptsMade + 1 }, 'bursar-derive-scope: starting');

  let sourceText = job.data.source_text ?? null;
  let sourceDocHash: string | null = null;

  if (!sourceText) {
    // Resolve the PINNED Bin version and re-assert readability at read time (spec 5.8).
    const db = getDb();
    const row = rows<{
      bin_asset_version_id: string | null;
      object_key: string | null;
      content_type: string | null;
      scan_status: string | null;
      asset_org: string | null;
    }>(
      await db.execute(sql`
        SELECT r.bin_asset_version_id, v.object_key, v.content_type, a.scan_status, a.org_id AS asset_org
          FROM bursar_requests r
          LEFT JOIN bin_asset_versions v ON v.id = r.bin_asset_version_id
          LEFT JOIN bin_assets a ON a.id = r.bin_asset_id
         WHERE r.id = ${request_id} AND r.organization_id = ${organization_id}
         LIMIT 1
      `),
    )[0];
    if (!row || !row.object_key) {
      logger.warn({ jobId: job.id, request_id }, 'bursar-derive-scope: no pinned Bin version / object key; nothing to derive');
      return;
    }
    if (row.asset_org !== organization_id || row.scan_status !== 'clean') {
      logger.warn({ jobId: job.id, request_id, scan_status: row.scan_status }, 'bursar-derive-scope: Bin re-assertion failed; not reading bytes');
      return;
    }
    logger.info({ jobId: job.id, object_key: row.object_key }, 'bursar-derive-scope: reading pinned Bin bytes');
    const buf = await getObjectBuffer(row.object_key);
    if (!buf) throw new Error(`bursar-derive-scope: object not readable: ${row.object_key}`);
    sourceText = extractText(buf, row.content_type);
    sourceDocHash = createHash('sha256').update(buf).digest('hex');
  } else {
    sourceDocHash = createHash('sha256').update(sourceText).digest('hex');
  }

  // Poll the async-start engine one chunk per call until done.
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const res = await postBursar('/v1/internal/run-derivation', {
      organization_id,
      request_id,
      run_id,
      source_text: sourceText,
      source_doc_hash: sourceDocHash,
      claimant,
    });
    if (res.status === 409) {
      logger.info({ jobId: job.id, run_id }, 'bursar-derive-scope: run claimed by another worker; ending this attempt');
      return;
    }
    if (res.status === 429) {
      // Throttled: let BullMQ back off and retry, resuming from the checkpoint.
      throw new Error('bursar-derive-scope: LLM throttled; will retry from checkpoint');
    }
    if (res.status === 404) {
      logger.warn({ jobId: job.id, run_id }, 'bursar-derive-scope: run not found; ending');
      return;
    }
    if (!res.ok) throw new Error(`bursar-derive-scope: run-derivation returned ${res.status}`);
    const data = (res.data as { data?: { done?: boolean; status?: string; processedChunk?: number | null } } | undefined)?.data;
    logger.info({ jobId: job.id, run_id, poll, chunk: data?.processedChunk, status: data?.status, elapsedMs: Date.now() - started }, 'bursar-derive-scope: slice done');
    if (data?.done) {
      logger.info({ jobId: job.id, run_id, status: data.status, elapsedMs: Date.now() - started }, 'bursar-derive-scope: complete');
      return;
    }
  }
  throw new Error('bursar-derive-scope: exceeded max polls without completing');
}
