/**
 * Bulwark obligation-extraction (Bulwark spec §4.1 / §9.2). Event-driven queue consumer.
 *
 * Enqueued by bulwark-api's POST /contracts + /contracts/:id/extract with { org_id, contract_id }.
 * The worker owns the Bin BYTE path (spec §9.2): it resolves the contract's bin.asset object key
 * from the shared DB, reads the bytes via @bigbluebam/storage (exactly like bin-transcode /
 * bin-av-scan), extracts text (PDF text layer best-effort; a scanned/image-only PDF yields ~zero
 * text and the engine flags it), computes source_doc_hash, and POSTs the text to bulwark-api's
 * /v1/internal/run-extraction, which runs the checkpointed LLM-extraction engine (chunk, verify
 * cited spans, compute the identity-stable dedup_key, upsert, supersession-aware).
 *
 * Idempotent: the engine hash-skips an unchanged doc after a succeeded run and upserts on the
 * stable dedup_key, so a re-run never orphans an armed clock. Bounded retry + backoff via BullMQ.
 */
import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BulwarkExtractObligationsJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { getObjectBuffer } from '../utils/storage.js';
import { postBulwark } from './bulwark-shared.js';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// Best-effort text extraction. Plain text decodes directly; a PDF text layer is approximated by
// pulling parenthesized/hex string tokens out of the content streams (good enough to feed the
// LLM extractor; a scanned/image-only PDF has no such tokens and yields ~empty text, which the
// engine surfaces as zero obligations - the spec's documented behavior for image-only docs).
function extractText(buf: Buffer, contentType: string | null): string {
  const isPdf = (contentType ?? '').includes('pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf) return buf.toString('utf8');
  const latin = buf.toString('latin1');
  const out: string[] = [];
  // Text-show operators wrap literal strings in ( ... ); pull those runs.
  const re = /\(((?:\\.|[^\\()])*)\)\s*T[jJ]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const s = (m[1] ?? '')
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    if (s.trim()) out.push(s);
  }
  return out.join(' ');
}

export async function processBulwarkExtractJob(
  job: Job<BulwarkExtractObligationsJobData>,
  logger: Logger,
): Promise<void> {
  const { org_id, contract_id } = job.data;
  const started = Date.now();
  logger.info({ jobId: job.id, org_id, contract_id, attempt: job.attemptsMade + 1 }, 'bulwark-extract: starting');

  const db = getDb();
  const contract = rows<{ bin_asset_id: string; object_key: string | null; content_type: string | null }>(
    await db.execute(sql`
      SELECT c.bin_asset_id, a.object_key, a.content_type
        FROM bulwark_contracts c
        LEFT JOIN bin_assets a ON a.id = c.bin_asset_id
       WHERE c.id = ${contract_id} AND c.organization_id = ${org_id}
       LIMIT 1
    `),
  )[0];
  if (!contract) {
    logger.warn({ jobId: job.id, contract_id }, 'bulwark-extract: contract not found; skipping');
    return;
  }
  if (!contract.object_key) {
    logger.warn(
      { jobId: job.id, contract_id, bin_asset_id: contract.bin_asset_id },
      'bulwark-extract: bin asset has no object key; cannot read bytes (skipping)',
    );
    return;
  }

  logger.info({ jobId: job.id, object_key: contract.object_key }, 'bulwark-extract: reading bin bytes');
  const buf = await getObjectBuffer(contract.object_key);
  if (!buf) {
    // Retryable: object may be mid-upload / storage blip. Throw so BullMQ backs off and retries.
    throw new Error(`bulwark-extract: object not readable: ${contract.object_key}`);
  }
  const sourceText = extractText(buf, contract.content_type);
  const sourceDocHash = createHash('sha256').update(buf).digest('hex');
  logger.info(
    { jobId: job.id, bytes: buf.length, text_chars: sourceText.length },
    'bulwark-extract: text extracted; invoking engine (POST /internal/run-extraction)',
  );

  const res = await postBulwark(
    '/internal/run-extraction',
    { org_id, contract_id, source_text: sourceText, source_doc_hash: sourceDocHash },
    120_000,
  );
  logger.info(
    { jobId: job.id, org_id, contract_id, result: res.data, elapsedMs: Date.now() - started },
    'bulwark-extract: done',
  );
}
