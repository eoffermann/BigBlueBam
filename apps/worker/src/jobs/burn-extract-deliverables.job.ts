/**
 * Burn deliverable-extraction (spec 4.1 / 8.1). Event-driven queue consumer, enqueued by
 * burn-api's POST /v1/engagements (with a bin_asset_id) and /v1/engagements/:id/extract.
 *
 * The worker owns the Bin BYTE path: it resolves the engagement's bin.asset object key from the
 * shared DB, reads the bytes via @bigbluebam/storage (like bulwark-extract / bin-transcode),
 * best-effort text-extracts, computes source_doc_hash, and POSTs the text to burn-api's
 * /v1/internal/run-extraction, which runs the checkpointed LLM-extraction engine (chunk, verify
 * cited spans, dedup-key upsert). NO advisory lock is held across the LLM call (spec 4.0); a
 * retry resumes from last_processed_chunk rather than restarting at chunk zero.
 *
 * Idempotent: the engine hash-skips an unchanged doc after a succeeded run. Bounded retry/backoff
 * via BullMQ attempts.
 */
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BurnExtractDeliverablesJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { getObjectBuffer } from '../utils/storage.js';
import { postBurn } from './burn-shared.js';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// Best-effort text extraction (same shape as bulwark-extract): plain text decodes directly; a PDF
// text layer is approximated from parenthesized show-operator strings. An image-only scan yields
// ~empty text and the engine surfaces zero deliverables (no OCR in v1, spec 4.1).
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
  return out.join(' ');
}

export async function processBurnExtractDeliverablesJob(
  job: Job<BurnExtractDeliverablesJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id, engagement_id } = job.data;
  const started = Date.now();
  logger.info({ jobId: job.id, organization_id, engagement_id, attempt: job.attemptsMade + 1 }, 'burn-extract-deliverables: starting');

  const db = getDb();
  const eng = rows<{ bin_asset_id: string | null; object_key: string | null; content_type: string | null }>(
    await db.execute(sql`
      SELECT e.bin_asset_id, a.object_key, a.content_type
        FROM burn_engagements e
        LEFT JOIN bin_assets a ON a.id = e.bin_asset_id
       WHERE e.id = ${engagement_id} AND e.organization_id = ${organization_id}
       LIMIT 1
    `),
  )[0];
  if (!eng) {
    logger.warn({ jobId: job.id, engagement_id }, 'burn-extract-deliverables: engagement not found; skipping');
    return;
  }
  if (!eng.bin_asset_id || !eng.object_key) {
    logger.warn({ jobId: job.id, engagement_id }, 'burn-extract-deliverables: no bin asset / object key; nothing to extract');
    return;
  }

  logger.info({ jobId: job.id, object_key: eng.object_key }, 'burn-extract-deliverables: reading bin bytes');
  const buf = await getObjectBuffer(eng.object_key);
  if (!buf) throw new Error(`burn-extract-deliverables: object not readable: ${eng.object_key}`);

  const sourceText = extractText(buf, eng.content_type);
  const sourceDocHash = createHash('sha256').update(buf).digest('hex');
  logger.info({ jobId: job.id, bytes: buf.length, text_chars: sourceText.length }, 'burn-extract-deliverables: text extracted; invoking engine');

  const res = await postBurn('/v1/internal/run-extraction', {
    organization_id, engagement_id, source_text: sourceText, source_doc_hash: sourceDocHash, doc_bytes: buf.length,
  });
  logger.info({ jobId: job.id, organization_id, engagement_id, result: res.data, elapsedMs: Date.now() - started }, 'burn-extract-deliverables: done');
}
