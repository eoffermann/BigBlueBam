/**
 * Internal LLM chat proxy for service-to-service calls.
 *
 * Bolt-api (and potentially other internal services) call
 * POST /internal/llm/chat to proxy chat completion requests through
 * the Bam API, which holds the encrypted LLM provider API keys.
 *
 * Auth: x-internal-secret header OR x-internal-token (reuses the
 * same INTERNAL_HELPDESK_SECRET for simplicity; both bolt-api and
 * helpdesk-api share the secret via INTERNAL_SERVICE_SECRET env var).
 *
 * Mount prefix: /internal/llm
 */
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmProviders } from '../db/schema/llm-providers.js';
import { decryptApiKey } from '../services/llm-provider.service.js';
import { env } from '../env.js';
import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Internal LLM concurrency cap (Burn spec 9.7.1)
//
// A per-calling-service Redis token bucket in front of POST /internal/llm/chat.
// The caller identifies itself with an `x-internal-service` header (e.g. `burn`,
// `bolt`); absent, it is `unknown`. Two independent limits are enforced and BOTH
// must admit or the request is rejected 429 + Retry-After:
//
//   - Concurrency: at most LLM_INTERNAL_MAX_CONCURRENT_PER_SERVICE in-flight
//     /chat calls per service. Held in a sorted set keyed by a random token with
//     score = admit time (ms). Stale tokens older than HOLD_WINDOW_MS are purged
//     on every admit so a crashed request cannot permanently hold a slot, and the
//     token is ZREM'd in a finally once the upstream call returns.
//   - Rate: a fixed one-minute window counter (INCR + EXPIRE 60). Exceeding
//     LLM_INTERNAL_RATE_PER_MINUTE rejects.
//
// Every Redis touch fails OPEN: a Redis outage must never block an LLM call,
// mirroring the platform's "availability fails open" posture. On a Redis error we
// log at debug and admit.
// ---------------------------------------------------------------------------

// Generous upper bound on a single /chat call (upstream timeout is 60s); a token
// older than this is treated as a leaked slot from a crashed request.
const INFLIGHT_HOLD_WINDOW_MS = 90_000;

function bucketKey(service: string): string {
  return `llm:bucket:${service}`;
}

interface BucketAdmission {
  admitted: boolean;
  // Set when rejected: HTTP Retry-After value in seconds.
  retryAfter?: number;
  // Set when admitted via the concurrency slot: the token to release.
  inflightToken?: string;
  service: string;
}

/**
 * Try to admit one /chat call for `service`. Fails OPEN on any Redis error.
 * When admitted through the concurrency slot, returns the token to release later.
 */
async function admitLlmCall(
  redis: Redis | undefined,
  service: string,
  log: import('fastify').FastifyBaseLogger,
): Promise<BucketAdmission> {
  if (!redis) return { admitted: true, service };

  const base = bucketKey(service);
  const now = Date.now();

  // ── Rate: fixed one-minute window ──────────────────────────────────────
  try {
    const minuteEpoch = Math.floor(now / 60_000);
    const rateKey = `${base}:rate:${minuteEpoch}`;
    const count = await redis.incr(rateKey);
    if (count === 1) await redis.expire(rateKey, 60);
    if (count > env.LLM_INTERNAL_RATE_PER_MINUTE) {
      const secondsToWindowEnd = Math.max(1, Math.ceil(((minuteEpoch + 1) * 60_000 - now) / 1000));
      return { admitted: false, retryAfter: secondsToWindowEnd, service };
    }
  } catch (err) {
    log.debug({ err, service }, 'internal-llm: rate bucket check failed; admitting (fail-open)');
    return { admitted: true, service };
  }

  // ── Concurrency: leak-safe in-flight sorted set ────────────────────────
  try {
    const inflightKey = `${base}:inflight`;
    const token = globalThis.crypto.randomUUID();
    // Purge leaked slots, then admit our token, then count. Doing the ZADD before
    // the ZCARD keeps the check-and-set atomic enough for this advisory cap; if we
    // are over the limit we immediately ZREM our own token and reject.
    await redis.zremrangebyscore(inflightKey, 0, now - INFLIGHT_HOLD_WINDOW_MS);
    await redis.zadd(inflightKey, now, token);
    await redis.expire(inflightKey, Math.ceil(INFLIGHT_HOLD_WINDOW_MS / 1000));
    const inFlight = await redis.zcard(inflightKey);
    if (inFlight > env.LLM_INTERNAL_MAX_CONCURRENT_PER_SERVICE) {
      await redis.zrem(inflightKey, token).catch(() => {});
      return { admitted: false, retryAfter: 1, service };
    }
    return { admitted: true, inflightToken: token, service };
  } catch (err) {
    log.debug({ err, service }, 'internal-llm: concurrency bucket check failed; admitting (fail-open)');
    return { admitted: true, service };
  }
}

/** Release a concurrency slot. Never throws. */
async function releaseLlmSlot(
  redis: Redis | undefined,
  service: string,
  token: string | undefined,
): Promise<void> {
  if (!redis || !token) return;
  try {
    await redis.zrem(`${bucketKey(service)}:inflight`, token);
  } catch {
    // Swallow: the HOLD_WINDOW purge reaps it on the next admit.
  }
}

// Per-request held concurrency slot, released by the onResponse hook once the
// upstream call has fully returned. A WeakMap avoids augmenting FastifyRequest and
// is naturally cleaned up when the request object is collected.
const heldSlots = new WeakMap<
  import('fastify').FastifyRequest,
  { service: string; token: string }
>();

// ---------------------------------------------------------------------------
// Internal auth guard (accepts x-internal-secret or x-internal-token)
// ---------------------------------------------------------------------------

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function requireInternalAuth(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
) {
  // Accept either header name so bolt-api (x-internal-secret) and
  // helpdesk-api (x-internal-token) can both call this endpoint.
  const secretHeader = request.headers['x-internal-secret'];
  const tokenHeader = request.headers['x-internal-token'];
  const provided = (
    Array.isArray(secretHeader) ? secretHeader[0] : secretHeader
  ) ?? (
    Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader
  );

  if (!provided || typeof provided !== 'string') {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing internal service token',
        details: [],
        request_id: request.id,
      },
    });
  }

  // Check against both secrets (INTERNAL_SERVICE_SECRET is optional)
  const secrets = [env.INTERNAL_HELPDESK_SECRET];
  if (env.INTERNAL_SERVICE_SECRET) {
    secrets.push(env.INTERNAL_SERVICE_SECRET);
  }

  const matched = secrets.some((s) => timingSafeStringEqual(provided, s));
  if (!matched) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid internal service token',
        details: [],
        request_id: request.id,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const chatRequestSchema = z.object({
  provider_id: z.string().uuid(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    }),
  ).min(1),
  model: z.string().max(200).optional(),
  max_tokens: z.number().int().positive().max(100000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export default async function internalLlmRoutes(fastify: FastifyInstance) {
  // Release a held concurrency slot once the response is fully sent (spec 9.7.1).
  // Only /chat admissions populate heldSlots; every other path is a no-op.
  fastify.addHook('onResponse', async (request) => {
    const slot = heldSlots.get(request);
    if (slot) {
      heldSlots.delete(request);
      await releaseLlmSlot(fastify.redis, slot.service, slot.token);
    }
  });

  /**
   * POST /internal/llm/chat
   *
   * Resolves the provider by ID, decrypts the API key, and proxies
   * a chat completion request to the upstream LLM (Anthropic or
   * OpenAI-compatible). Returns `{ data: { content } }`.
   */
  fastify.post(
    '/chat',
    { preHandler: [requireInternalAuth] },
    async (request, reply) => {
      const body = chatRequestSchema.parse(request.body);

      // Internal LLM concurrency cap (spec 9.7.1): admit through the per-service
      // token bucket before any provider work. Fails open on a Redis outage. A
      // held slot is released by the onResponse hook once the reply is sent.
      const svcHeader = request.headers['x-internal-service'];
      const service =
        (Array.isArray(svcHeader) ? svcHeader[0] : svcHeader)?.toString().slice(0, 64) ||
        'unknown';
      const admission = await admitLlmCall(fastify.redis, service, request.log);
      if (!admission.admitted) {
        reply.header('Retry-After', String(admission.retryAfter ?? 1));
        return reply.status(429).send({
          error: {
            code: 'RATE_LIMITED',
            message: `Internal LLM concurrency/rate cap reached for service "${service}"`,
            details: [],
            request_id: request.id,
          },
        });
      }
      if (admission.inflightToken) {
        heldSlots.set(request, { service, token: admission.inflightToken });
      }

      // Fetch the provider row (raw, with encrypted key)
      const [provider] = await db
        .select()
        .from(llmProviders)
        .where(
          and(
            eq(llmProviders.id, body.provider_id),
            eq(llmProviders.enabled, true),
          ),
        )
        .limit(1);

      if (!provider) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'LLM provider not found or is disabled',
            details: [],
            request_id: request.id,
          },
        });
      }

      let apiKey: string;
      try {
        apiKey = decryptApiKey(provider.api_key_encrypted);
      } catch {
        request.log.error(
          { providerId: provider.id },
          'internal-llm: failed to decrypt provider API key',
        );
        return reply.status(500).send({
          error: {
            code: 'DECRYPTION_ERROR',
            message: 'Failed to decrypt the LLM provider API key',
            details: [],
            request_id: request.id,
          },
        });
      }

      const model = body.model ?? provider.model_id;
      const maxTokens = body.max_tokens ?? provider.max_tokens ?? 4096;
      const temperature = body.temperature ?? (provider.temperature != null ? Number(provider.temperature) : 0.7);

      try {
        if (provider.provider_type === 'anthropic') {
          const endpoint = provider.api_endpoint || 'https://api.anthropic.com';
          const response = await fetch(`${endpoint}/v1/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              messages: body.messages.filter((m) => m.role !== 'system'),
              ...(body.messages.some((m) => m.role === 'system')
                ? { system: body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') }
                : {}),
              temperature,
            }),
            signal: AbortSignal.timeout(60000),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            request.log.warn(
              { status: response.status, body: errText.slice(0, 500) },
              'internal-llm: upstream Anthropic error',
            );
            return reply.status(502).send({
              error: {
                code: 'UPSTREAM_ERROR',
                message: `LLM provider returned HTTP ${response.status}`,
                details: [],
                request_id: request.id,
              },
            });
          }

          const result = await response.json() as {
            content?: Array<{ type: string; text?: string }>;
          };
          const text = result.content?.find((c) => c.type === 'text')?.text ?? '';

          return reply.send({ data: { content: text } });
        } else {
          // OpenAI or OpenAI-compatible
          const endpoint = provider.api_endpoint || 'https://api.openai.com';
          const response = await fetch(`${endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              messages: body.messages,
              temperature,
            }),
            signal: AbortSignal.timeout(60000),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            request.log.warn(
              { status: response.status, body: errText.slice(0, 500) },
              'internal-llm: upstream OpenAI-compatible error',
            );
            return reply.status(502).send({
              error: {
                code: 'UPSTREAM_ERROR',
                message: `LLM provider returned HTTP ${response.status}`,
                details: [],
                request_id: request.id,
              },
            });
          }

          const result = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = result.choices?.[0]?.message?.content ?? '';

          return reply.send({ data: { content: text } });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        request.log.error({ err }, 'internal-llm: proxy call failed');
        return reply.status(502).send({
          error: {
            code: 'UPSTREAM_ERROR',
            message: `LLM proxy call failed: ${message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );
}
