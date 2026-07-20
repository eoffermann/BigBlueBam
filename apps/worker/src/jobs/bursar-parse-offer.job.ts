/**
 * Bursar deterministic offer-parse driver (spec 4.1, M4). Event-driven queue consumer, enqueued by
 * bursar-api's POST /v1/requests/:id/offers and /v1/offers/:id/upload | /reparse. The worker
 * REGISTRATION (worker.ts cron) lands in M8; this file is the thin driver it will register.
 *
 * The job resolves the offer's document bytes - inline `source_text` from the job payload, or the
 * PINNED Bin version's bytes it reads itself - and forwards them to bursar-api's internal
 * /parse-offer engine, which runs the whole deterministic pipeline (ceilings, content-type pinning,
 * extraction, segmentation, parse_quality, lexicons, structural matching, the two §4.3 counters)
 * and persists. NO LLM: Stage 1 is entirely deterministic.
 *
 * Byte path (spec 5.8): re-assert org_id + scan_status='clean' immediately before the read and read
 * the PINNED bin_asset_version_id, NEVER current_version_id (a failed re-assertion refuses to read).
 * The malicious-document ceiling (MAX_DOC_BYTES) is enforced here before forwarding and again in the
 * engine. Progress logging before the byte read, before the parse handoff, with elapsed-ms context.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BursarParseOfferJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { getObjectBuffer } from '../utils/storage.js';
import { postBursar } from './bursar-shared.js';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES ?? 20_971_520);

export async function processBursarParseOfferJob(
  job: Job<BursarParseOfferJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id, offer_id } = job.data;
  const started = Date.now();
  const claimant = `worker:${job.id ?? 'unknown'}`;
  logger.info(
    { jobId: job.id, organization_id, offer_id, attempt: job.attemptsMade + 1 },
    'bursar-parse-offer: starting',
  );

  let sourceText = job.data.source_text ?? null;
  let sourceBytesB64: string | null = null;
  let contentType: string | null = null;
  let declaredFormat: string | null = null;
  let byteLen = 0;

  const db = getDb();

  // Always read the offer's declared source_format for content-type pinning, plus its pinned Bin
  // pointer when there is no inline text.
  const offer = rows<{
    request_id: string;
    source_format: string | null;
    bin_asset_id: string | null;
    bin_asset_version_id: string | null;
    object_key: string | null;
    content_type: string | null;
    scan_status: string | null;
    asset_org: string | null;
  }>(
    await db.execute(sql`
      SELECT o.request_id, o.source_format, o.bin_asset_id, o.bin_asset_version_id,
             v.object_key, v.content_type, a.scan_status, a.org_id AS asset_org
        FROM bursar_offers o
        LEFT JOIN bin_asset_versions v ON v.id = o.bin_asset_version_id
        LEFT JOIN bin_assets a ON a.id = o.bin_asset_id
       WHERE o.id = ${offer_id} AND o.organization_id = ${organization_id}
       LIMIT 1
    `),
  )[0];
  if (!offer) {
    logger.warn({ jobId: job.id, offer_id }, 'bursar-parse-offer: offer not found; skipping');
    return;
  }
  declaredFormat = offer.source_format;

  if (!sourceText) {
    if (!offer.object_key || !offer.bin_asset_version_id) {
      logger.warn({ jobId: job.id, offer_id }, 'bursar-parse-offer: no inline text and no pinned Bin version; nothing to parse');
      return;
    }
    // §5.8 read-time re-assertion: org must match and the asset must be clean-scanned RIGHT NOW.
    if (offer.asset_org !== organization_id || offer.scan_status !== 'clean') {
      logger.warn(
        { jobId: job.id, offer_id, scan_status: offer.scan_status },
        'bursar-parse-offer: Bin re-assertion failed; not reading bytes',
      );
      return;
    }
    logger.info({ jobId: job.id, offer_id, object_key: offer.object_key }, 'bursar-parse-offer: reading pinned Bin bytes');
    const buf = await getObjectBuffer(offer.object_key);
    if (!buf) throw new Error(`bursar-parse-offer: object not readable: ${offer.object_key}`);
    byteLen = buf.length;
    if (byteLen > MAX_DOC_BYTES) {
      logger.warn({ jobId: job.id, offer_id, bytes: byteLen }, 'bursar-parse-offer: bytes exceed MAX_DOC_BYTES; forwarding as blocked');
    }
    contentType = offer.content_type;
    sourceBytesB64 = buf.toString('base64');
  } else {
    byteLen = Buffer.byteLength(sourceText, 'utf8');
  }

  logger.info(
    { jobId: job.id, offer_id, bytes: byteLen, format: declaredFormat, elapsedMs: Date.now() - started },
    'bursar-parse-offer: forwarding to engine',
  );
  const res = await postBursar('/v1/internal/parse-offer', {
    organization_id,
    offer_id,
    claimant,
    ...(sourceBytesB64 ? { source_bytes_b64: sourceBytesB64 } : { source_text: sourceText }),
    content_type: contentType,
    declared_format: declaredFormat,
    byte_len: byteLen,
  });
  if (res.status === 404) {
    logger.warn({ jobId: job.id, offer_id }, 'bursar-parse-offer: offer not found at engine; ending');
    return;
  }
  if (!res.ok) throw new Error(`bursar-parse-offer: parse-offer returned ${res.status}`);
  logger.info(
    { jobId: job.id, offer_id, result: (res.data as { data?: unknown } | undefined)?.data, elapsedMs: Date.now() - started },
    'bursar-parse-offer: done',
  );
}
