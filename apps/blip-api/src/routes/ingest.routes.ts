/**
 * Public ingest surface (Blip §4). Authenticated by the ingest key (X-Blip-Key),
 * not the session. Mounted at /ingest (nginx maps /blip/ingest/ -> :4018/ingest/),
 * so the canonical endpoint is POST /blip/ingest/v1.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { parseToken, verifySecret } from '../lib/ingest-keys.js';
import { consumeToken } from '../lib/rate-limit.js';
import { resolveKey, processBatch } from '../services/ingest.service.js';

function defaultBucket(rl: Record<string, unknown> | null, hasCaptures: boolean) {
  const refill = Number(rl?.refill_per_sec ?? 50);
  const burst = Number(rl?.burst ?? 200);
  const maxBody = Number(
    (hasCaptures ? rl?.max_capture_body_bytes : rl?.max_body_bytes) ??
      (hasCaptures ? env.BLIP_MAX_CAPTURE_BODY_BYTES : env.BLIP_MAX_BODY_BYTES),
  );
  const maxBatch = Number(rl?.max_batch_count ?? env.BLIP_MAX_BATCH_COUNT);
  return { refill, burst, maxBody, maxBatch };
}

export default async function ingestRoutes(fastify: FastifyInstance) {
  // NDJSON support (one JSON object per line) for high-throughput clients.
  fastify.addContentTypeParser(
    ['application/x-ndjson', 'application/jsonl'],
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const arr = String(body)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        done(null, arr);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  fastify.post('/v1', async (request, reply) => {
    const sendErr = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
      reply.status(status).send({ error: { code, message, details: [], request_id: request.id, ...extra } });

    // 1. Parse key id (string split, no DB).
    const header = request.headers['x-blip-key'];
    const token = Array.isArray(header) ? header[0] : header;
    const parsed = parseToken(token);
    if (!parsed) return sendErr(401, 'INVALID_KEY', 'Missing or malformed X-Blip-Key');

    // 2. Resolve key from Redis cache (DB fallback).
    const key = await resolveKey(fastify.redis, parsed.keyId);
    if (!key) return sendErr(403, 'INVALID_KEY', 'Unknown ingest key');

    // 3. Status / collection checks.
    if (key.status !== 'active') return sendErr(403, 'KEY_INACTIVE', `Key is ${key.status}`);
    if (!key.collection_enabled) return sendErr(409, 'COLLECTION_DISABLED', 'Collection is disabled for this app');

    // 4. Constant-time HMAC verify.
    if (!verifySecret(parsed.secret, key.secret_hmac, env.BLIP_INGEST_PEPPER)) {
      return sendErr(403, 'INVALID_KEY', 'Key verification failed');
    }

    // 5. Token-bucket rate limit (per key, then per app). Both must pass.
    const contentType = String(request.headers['content-type'] ?? '');
    const hasCaptures = false; // capture-aware cap re-checked after parse below
    const bucket = defaultBucket(key.rate_limit, hasCaptures);
    const nowMs = Date.now();
    const bucketParams = { refill_per_sec: bucket.refill, burst: bucket.burst };
    const keyRl = await consumeToken(fastify.redis, `blip:rl:key:${parsed.keyId}`, bucketParams, nowMs);
    if (!keyRl.allowed) {
      reply.header('Retry-After', Math.ceil(keyRl.retryAfterMs / 1000));
      return sendErr(429, 'RATE_LIMITED', 'Per-key rate limit exceeded');
    }
    const appRl = await consumeToken(fastify.redis, `blip:rl:app:${key.tracked_app_id}`, bucketParams, nowMs);
    if (!appRl.allowed) {
      reply.header('Retry-After', Math.ceil(appRl.retryAfterMs / 1000));
      return sendErr(429, 'RATE_LIMITED', 'Per-app rate limit exceeded');
    }

    // 6. Body size cap.
    const lenHeader = Number(request.headers['content-length'] ?? 0);
    const body = request.body;
    const bodyHasCaptures = JSON.stringify(body ?? {}).includes('"screen_captures"');
    const cap = bodyHasCaptures ? Number(key.rate_limit?.max_capture_body_bytes ?? env.BLIP_MAX_CAPTURE_BODY_BYTES) : bucket.maxBody;
    if (lenHeader > cap) return sendErr(413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${cap} bytes`);

    // 7. Parse body into elements (single object | array | NDJSON-parsed array).
    let elements: unknown[];
    if (Array.isArray(body)) elements = body;
    else if (body && typeof body === 'object') elements = [body];
    else return sendErr(422, 'INVALID_BODY', 'Body must be a JSON object, array, or NDJSON');

    if (elements.length > bucket.maxBatch) {
      return sendErr(422, 'BATCH_TOO_LARGE', `Batch exceeds ${bucket.maxBatch} elements`);
    }
    void contentType;

    // 8-12. Redact, watch, tail, enqueue.
    const result = await processBatch(fastify.redis, { key }, elements);

    // Best-effort last_used_at bump (async, no await on hot path is fine here).
    return reply.status(202).send({
      accepted: result.accepted,
      rejected: result.rejected,
      ...(result.rejected_index.length > 0 ? { rejected_index: result.rejected_index } : {}),
    });
  });
}
