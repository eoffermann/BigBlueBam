/**
 * Blip ingest hot path (Blip §4.1). Resolves the ingest key from a Redis cache
 * (DB fallback), applies the compiled PII transform at the edge, evaluates
 * match/window watches, publishes each redacted element to the live-tail
 * channel, and enqueues the redacted batch for durable write. No durable write
 * happens on the request thread.
 */
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { db } from '../db/index.js';
import { blipIngestKeys } from '../db/schema/blip-ingest-keys.js';
import { blipTrackedApps } from '../db/schema/blip-tracked-apps.js';
import { blipTransforms } from '../db/schema/blip-transforms.js';
import { env } from '../env.js';
import {
  KEY_CACHE_PREFIX,
  KEY_CACHE_TTL_SEC,
  type KeyCacheEntry,
} from '../lib/ingest-keys.js';
import { compileTransform, type CompiledTransform, type TransformRule } from '../lib/transform.js';
import { publishTail, type TailEntry } from '../lib/broadcast.js';
import { evaluateWatches } from '../lib/watch-eval.js';
import { enqueueIngest } from '../lib/queue.js';
import type { BlipQueuedEntry } from '@bigbluebam/shared';

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

/** Resolve an ingest key by key_id from Redis cache, falling back to the DB. */
export async function resolveKey(redis: Redis, keyId: string): Promise<KeyCacheEntry | null> {
  const cacheKey = `${KEY_CACHE_PREFIX}${keyId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as KeyCacheEntry;
  } catch {
    // fall through to DB
  }
  const rows = await db
    .select({
      key_db_id: blipIngestKeys.id,
      tracked_app_id: blipIngestKeys.tracked_app_id,
      org_id: blipIngestKeys.org_id,
      secret_hmac: blipIngestKeys.secret_hmac,
      status: blipIngestKeys.status,
      rate_limit_override: blipIngestKeys.rate_limit_override,
      collection_enabled: blipTrackedApps.collection_enabled,
      app_rate_limit: blipTrackedApps.rate_limit,
      transform_version: blipTrackedApps.transform_version,
    })
    .from(blipIngestKeys)
    .innerJoin(blipTrackedApps, eq(blipIngestKeys.tracked_app_id, blipTrackedApps.id))
    .where(eq(blipIngestKeys.key_id, keyId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const entry: KeyCacheEntry = {
    tracked_app_id: row.tracked_app_id,
    org_id: row.org_id,
    key_db_id: row.key_db_id,
    secret_hmac: row.secret_hmac,
    status: row.status,
    collection_enabled: row.collection_enabled,
    rate_limit: (row.rate_limit_override as Record<string, unknown> | null) ??
      (row.app_rate_limit as Record<string, unknown> | null),
    transform_version: row.transform_version,
  };
  try {
    await redis.set(cacheKey, JSON.stringify(entry), 'EX', KEY_CACHE_TTL_SEC);
  } catch {
    // cache write best-effort
  }
  return entry;
}

// Compiled-transform cache keyed by `${trackedAppId}:${version}`.
const transformCache = new Map<string, { at: number; transforms: CompiledTransform[] }>();
const TRANSFORM_TTL_MS = 30_000;

async function loadTransforms(trackedAppId: string, version: number): Promise<CompiledTransform[]> {
  const key = `${trackedAppId}:${version}`;
  const cached = transformCache.get(key);
  if (cached && Date.now() - cached.at < TRANSFORM_TTL_MS) return cached.transforms;
  const rows = await db
    .select()
    .from(blipTransforms)
    .where(eq(blipTransforms.tracked_app_id, trackedAppId));
  const transforms = rows
    .filter((r) => r.enabled)
    .map((r) => compileTransform(r.rules as TransformRule[], r.version, env.BLIP_INGEST_PEPPER));
  transformCache.set(key, { at: Date.now(), transforms });
  return transforms;
}

/** Drop the compiled-transform cache for an app (after transform edits). */
export function invalidateTransformCache(trackedAppId: string): void {
  for (const k of [...transformCache.keys()]) {
    if (k.startsWith(`${trackedAppId}:`)) transformCache.delete(k);
  }
}

export type IngestResult = { accepted: number; rejected: number; rejected_index: number[] };

/**
 * Validate, redact, tail, evaluate watches, and enqueue a parsed batch of report
 * elements. Malformed elements are dropped and counted, never failing the batch.
 */
export async function processBatch(
  redis: Redis,
  ctx: { key: KeyCacheEntry },
  elements: unknown[],
): Promise<IngestResult> {
  const transforms = await loadTransforms(ctx.key.tracked_app_id, ctx.key.transform_version);
  const receivedAt = new Date();
  const receivedIso = receivedAt.toISOString();
  const queued: BlipQueuedEntry[] = [];
  const rejected_index: number[] = [];
  const nowMs = receivedAt.getTime();

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      rejected_index.push(i);
      continue;
    }
    const obj = el as Record<string, unknown>;
    const reportType = obj.report_type;
    if (typeof reportType !== 'string' || reportType.length === 0) {
      rejected_index.push(i);
      continue;
    }

    // Apply compiled PII transforms in order (edge redaction, Blip §9).
    let redacted = obj;
    for (const t of transforms) redacted = t.apply(redacted);

    // Build the tail copy: strip screen_captures to lightweight descriptors.
    const tailPayload = stripCapturesForTail(redacted);
    const tail: TailEntry = {
      seq: null,
      received_at: receivedIso,
      tracked_app_id: ctx.key.tracked_app_id,
      report_type: reportType,
      level: coerceLevel(redacted.level),
      session_id: asText(redacted.session_id),
      app_version: asText(redacted.app_version),
      platform: asText(redacted.platform),
      elapsed_ms: asNumber(redacted.elapsed_ms),
      capture_count: Array.isArray(redacted.screen_captures) ? redacted.screen_captures.length : 0,
      payload: tailPayload,
    };

    // Watches (match fire + window reservoir bump) at the edge.
    void evaluateWatches(redis, ctx.key.org_id, ctx.key.tracked_app_id, reportType, tail, nowMs);

    // Live tail publish (fire-and-forget).
    publishTail(redis, tail);

    queued.push({ report_type: reportType, payload: redacted });
  }

  if (queued.length > 0) {
    await enqueueIngest({
      org_id: ctx.key.org_id,
      tracked_app_id: ctx.key.tracked_app_id,
      ingest_key_id: ctx.key.key_db_id,
      received_at: receivedIso,
      entries: queued,
    });
  }

  return { accepted: queued.length, rejected: rejected_index.length, rejected_index };
}

function stripCapturesForTail(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.screen_captures)) return payload;
  const descriptors = payload.screen_captures.map((c, index) => ({
    index,
    bytes: typeof c === 'string' ? Math.floor((c.length * 3) / 4) : 0,
    pending: true,
  }));
  return { ...payload, screen_captures: descriptors };
}

function coerceLevel(v: unknown): string | null {
  return typeof v === 'string' && LEVELS.has(v) ? v : null;
}
function asText(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}
function asNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
