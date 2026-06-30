/**
 * Blip durable-write fan-in (Blip §4.2).
 *
 * The ingest edge (apps/blip-api) does the fast, safe work synchronously —
 * key auth, rate limit, PII redaction, live-tail publish, watch evaluation —
 * and enqueues the already-redacted batch here. This worker does the heavy,
 * latency-tolerant half:
 *
 *   1. Extract promoted reserved fields (§6) from each redacted payload. `level`
 *      is coerced against the enforced enum (debug|info|warn|error|fatal); an
 *      unrecognized value leaves the column null while the raw value stays in
 *      payload.level.
 *   2. Compute payload_bytes for byte-based retention accounting.
 *   3. Offload screen_captures (§23): decode each base64 JPEG, validate the magic
 *      bytes, generate a sharp thumbnail (max 320px long edge), put the full
 *      image + thumb to object storage under a partition-aligned key, and replace
 *      the inline base64 with a ref. Non-JPEG elements are dropped and counted.
 *   4. Upsert the observed field catalog per (tracked_app, report_type, field).
 *      A brand-new (app, report_type) emits report_type.first_seen.
 *   5. Multi-row INSERT into the partitioned blip_entries table (seq via the
 *      column DEFAULT nextval('blip_entry_seq')).
 *
 * This is the one heavy step in the pipeline and is deliberately async/batched.
 */

import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { publishBoltEvent, type BlipIngestJobData, type BlipQueuedEntry } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { putObjectBuffer } from '../utils/storage.js';

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const THUMB_MAX_EDGE = 320;
// Reserved keys promoted to their own column. field_path uses the column name;
// every other top-level payload key is cataloged as `payload:<key>`.
const RESERVED_FIELD_PATHS: Record<string, string> = {
  timestamp: 'client_ts',
  level: 'level',
  session_id: 'session_id',
  app_version: 'app_version',
  platform: 'platform',
  elapsed_ms: 'elapsed_ms',
};

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function coerceLevel(v: unknown): string | null {
  return typeof v === 'string' && LEVELS.has(v) ? v : null;
}
function asText(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}
function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function asClientTs(v: unknown): Date | null {
  if (v == null) return null;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

function inferType(v: unknown): string {
  if (v === null) return 'mixed';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'bool';
  if (t === 'string') return 'string';
  if (t === 'object') return 'object';
  return 'mixed';
}

/** received_at -> YYYY-MM partition segment used in the capture object key. */
function monthSegment(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

interface CaptureRef {
  object_key: string;
  thumb_key: string;
  bytes: number;
  content_type: 'image/jpeg';
  width: number | null;
  height: number | null;
  sha256: string;
}

/**
 * Offload one entry's screen_captures. Returns the rewritten payload (base64
 * replaced by refs; non-JPEG dropped) and the count of stored captures.
 */
async function offloadCaptures(
  payload: Record<string, unknown>,
  orgId: string,
  trackedAppId: string,
  monthSeg: string,
  seqDir: string,
  logger: Logger,
): Promise<{ payload: Record<string, unknown>; captureCount: number }> {
  const captures = payload.screen_captures;
  if (!Array.isArray(captures) || captures.length === 0) {
    return { payload, captureCount: 0 };
  }

  const refs: CaptureRef[] = [];
  let dropped = 0;
  for (let i = 0; i < captures.length; i++) {
    const el = captures[i];
    if (typeof el !== 'string') {
      dropped += 1;
      continue;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(el, 'base64');
    } catch {
      dropped += 1;
      continue;
    }
    if (!isJpeg(buf)) {
      dropped += 1;
      continue;
    }

    const base = `${orgId}/blip/${trackedAppId}/${monthSeg}/${seqDir}/${i}`;
    const objectKey = `${base}.jpg`;
    const thumbKey = `${base}.thumb.jpg`;

    let width: number | null = null;
    let height: number | null = null;
    let thumb: Buffer | null = null;
    try {
      const img = sharp(buf, { failOn: 'none' });
      const meta = await img.metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      thumb = await sharp(buf, { failOn: 'none' })
        .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      // A corrupt JPEG that passes the magic-byte check but fails decode: drop it
      // rather than fail the whole row.
      logger.warn(
        { trackedAppId, index: i, err: err instanceof Error ? err.message : String(err) },
        'blip-ingest: capture decode failed, dropping',
      );
      dropped += 1;
      continue;
    }

    try {
      await putObjectBuffer(objectKey, buf, 'image/jpeg');
      if (thumb) await putObjectBuffer(thumbKey, thumb, 'image/jpeg');
    } catch (err) {
      logger.error(
        { trackedAppId, objectKey, err: err instanceof Error ? err.message : String(err) },
        'blip-ingest: capture upload failed, dropping',
      );
      dropped += 1;
      continue;
    }

    refs.push({
      object_key: objectKey,
      thumb_key: thumbKey,
      bytes: buf.length,
      content_type: 'image/jpeg',
      width,
      height,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
  }

  if (dropped > 0) {
    logger.info({ trackedAppId, dropped, stored: refs.length }, 'blip-ingest: captures offloaded');
  }
  return { payload: { ...payload, screen_captures: refs }, captureCount: refs.length };
}

interface PreparedRow {
  seq: string;
  receivedAt: string;
  clientTs: Date | null;
  level: string | null;
  sessionId: string | null;
  appVersion: string | null;
  platform: string | null;
  elapsedMs: number | null;
  captureCount: number;
  payload: Record<string, unknown>;
  payloadBytes: number;
  reportType: string;
}

type CatalogAgg = Map<string, { type: string; count: number }>;

function accumulateCatalog(agg: CatalogAgg, payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'screen_captures' || key === 'report_type') continue;
    const fieldPath = RESERVED_FIELD_PATHS[key] ?? `payload:${key}`;
    const type = inferType(value);
    const cur = agg.get(fieldPath);
    if (!cur) {
      agg.set(fieldPath, { type, count: 1 });
    } else {
      cur.count += 1;
      if (cur.type !== type) cur.type = 'mixed';
    }
  }
}

export async function processBlipIngestJob(
  job: Job<BlipIngestJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { org_id, tracked_app_id, ingest_key_id, received_at, entries } = job.data;
  if (!entries || entries.length === 0) {
    logger.debug({ jobId: job.id }, 'blip-ingest: empty batch');
    return;
  }

  const receivedDate = new Date(received_at);
  const monthSeg = monthSegment(
    Number.isNaN(receivedDate.getTime()) ? new Date() : receivedDate,
  );

  // Per report_type: which are brand-new (no catalog row yet) so we emit
  // report_type.first_seen exactly once.
  const distinctTypes = [...new Set(entries.map((e: BlipQueuedEntry) => e.report_type))];
  const firstSeen = new Set<string>();
  for (const rt of distinctTypes) {
    const existing = rows<{ one: number }>(
      await db.execute(sql`
        SELECT 1 AS one FROM blip_field_catalog
        WHERE tracked_app_id = ${tracked_app_id} AND report_type = ${rt}
        LIMIT 1
      `),
    );
    if (existing.length === 0) firstSeen.add(rt);
  }

  // Pre-assign the durable seq for every row up front (one round-trip) so the
  // capture object key can embed the real seq (§23.2) and the INSERT carries the
  // same value rather than relying on the column DEFAULT.
  const seqs = rows<{ seq: string }>(
    await db.execute(sql`
      SELECT nextval('blip_entry_seq')::text AS seq
      FROM generate_series(1, ${entries.length})
    `),
  ).map((r) => r.seq);

  // Catalog aggregation per report_type across the whole batch (one upsert each).
  const catalogByType = new Map<string, CatalogAgg>();
  const prepared: PreparedRow[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const seq = seqs[i];
    if (!entry || seq === undefined) continue;
    const reportType = entry.report_type;
    const payload0 = (entry.payload ?? {}) as Record<string, unknown>;

    const { payload, captureCount } = await offloadCaptures(
      payload0,
      org_id,
      tracked_app_id,
      monthSeg,
      seq,
      logger,
    );

    const payloadJson = JSON.stringify(payload);
    prepared.push({
      seq,
      receivedAt: received_at,
      clientTs: asClientTs(payload.timestamp ?? payload.client_ts),
      level: coerceLevel(payload.level),
      sessionId: asText(payload.session_id),
      appVersion: asText(payload.app_version),
      platform: asText(payload.platform),
      elapsedMs: asNumber(payload.elapsed_ms),
      captureCount,
      payload,
      payloadBytes: Buffer.byteLength(payloadJson),
      reportType,
    });

    let agg = catalogByType.get(reportType);
    if (!agg) {
      agg = new Map();
      catalogByType.set(reportType, agg);
    }
    accumulateCatalog(agg, payload);
  }

  // 1) Field catalog upserts (one row per observed (app, report_type, field_path)).
  for (const [reportType, agg] of catalogByType) {
    for (const [fieldPath, { type, count }] of agg) {
      await db.execute(sql`
        INSERT INTO blip_field_catalog
          (org_id, tracked_app_id, report_type, field_path, inferred_type,
           first_seen, last_seen, observation_count)
        VALUES
          (${org_id}, ${tracked_app_id}, ${reportType}, ${fieldPath}, ${type},
           NOW(), NOW(), ${count})
        ON CONFLICT (tracked_app_id, report_type, field_path) DO UPDATE SET
          observation_count = blip_field_catalog.observation_count + EXCLUDED.observation_count,
          last_seen = NOW(),
          inferred_type = CASE
            WHEN blip_field_catalog.inferred_type = EXCLUDED.inferred_type
              THEN blip_field_catalog.inferred_type
            ELSE 'mixed'
          END
      `);
    }
  }

  // 2) report_type.first_seen Bolt events (after the catalog write so a retry
  //    that already inserted the catalog row won't re-fire).
  for (const rt of firstSeen) {
    await publishBoltEvent(
      'report_type.first_seen',
      'blip',
      { tracked_app_id, report_type: rt, org_id },
      org_id,
    );
  }

  // 3) Multi-row INSERT. seq is the pre-assigned nextval; id comes from the
  //    column DEFAULT (gen_random_uuid).
  const valueRows = prepared.map(
    (r) => sql`(
      ${r.receivedAt}::timestamptz,
      ${r.seq}::bigint,
      ${org_id}::uuid,
      ${tracked_app_id}::uuid,
      ${r.reportType},
      ${ingest_key_id}::uuid,
      ${r.clientTs ? r.clientTs.toISOString() : null}::timestamptz,
      ${r.level},
      ${r.sessionId},
      ${r.appVersion},
      ${r.platform},
      ${r.elapsedMs}::double precision,
      ${r.captureCount}::integer,
      ${JSON.stringify(r.payload)}::jsonb,
      ${r.payloadBytes}::integer
    )`,
  );

  await db.execute(sql`
    INSERT INTO blip_entries
      (received_at, seq, org_id, tracked_app_id, report_type, ingest_key_id,
       client_ts, level, session_id, app_version, platform, elapsed_ms,
       capture_count, payload, payload_bytes)
    VALUES ${sql.join(valueRows, sql`, `)}
  `);

  logger.info(
    { jobId: job.id, trackedAppId: tracked_app_id, rows: prepared.length, firstSeen: firstSeen.size },
    'blip-ingest: batch written',
  );
}
