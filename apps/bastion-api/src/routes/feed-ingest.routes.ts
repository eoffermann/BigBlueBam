import type { FastifyInstance } from 'fastify';
import { BASTION_FEED_KEY_RATE_PER_MINUTE, BASTION_FEED_MAX_BATCH_BYTES, bastionFeedBatchSchema } from '@bigbluebam/shared';
import { env } from '../env.js';
import { RateLimitedError } from '../lib/errors.js';
import { handled, validationError } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import { authenticateFeedPush, FeedAuthError, ingestFeedBatch } from '../services/feeds.service.js';

// Spec 5.1 row 48 (M5): POST /feeds/:feed_key/records, the machine push. NOT a user route: it has
// no session or API key and no requireCan; the caller authenticates with its per-feed key
// (`Authorization: Bearer bbf_<key_id>_<secret>`, shown once at mint, only an HMAC stored).
// Limits (spec 3.5): 2 MB per batch (route bodyLimit; larger is 413), 500 records (schema),
// 60 requests per minute per key (429), and the per-feed daily quota by UTC day (429).
// test/routes-permissions.test.ts checks this file separately.
export default async function feedIngestRoutes(fastify: FastifyInstance) {
  const deps = () => engineDeps(fastify.log, fastify.redis);

  fastify.post(
    '/feeds/:feed_key/records',
    { bodyLimit: BASTION_FEED_MAX_BATCH_BYTES, config: { rateLimit: false } },
    async (request, reply) => {
      const pathKey = String((request.params as { feed_key?: string }).feed_key ?? '');
      const unauthorized = () =>
        reply.status(401).send({
          error: { code: 'FEED_KEY_INVALID', message: 'This feed key is not valid for this feed.', details: [], request_id: request.id },
        });
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(pathKey)) return unauthorized();

      let auth: Awaited<ReturnType<typeof authenticateFeedPush>>;
      try {
        auth = await authenticateFeedPush(deps(), pathKey, request.headers.authorization, env.BASTION_FEED_KEY_PEPPER);
      } catch (err) {
        if (err instanceof FeedAuthError) return unauthorized();
        return handled(request, reply, () => Promise.reject(err));
      }

      // 60 requests per minute per key, counted in Redis so every bastion-api instance agrees.
      const minute = Math.floor(Date.now() / 60_000);
      const rlKey = `bastion:feed-rate:${auth.keyRowId}:${minute}`;
      const count = await fastify.redis.incr(rlKey);
      if (count === 1) await fastify.redis.expire(rlKey, 70);
      if (count > BASTION_FEED_KEY_RATE_PER_MINUTE) {
        return handled(request, reply, () =>
          Promise.reject(new RateLimitedError(`This key may push at most ${BASTION_FEED_KEY_RATE_PER_MINUTE} batches a minute.`, 'FEED_KEY_RATE_LIMITED', 60 - (Math.floor(Date.now() / 1000) % 60))),
        );
      }

      const parsed = bastionFeedBatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const bytes = Number(request.headers['content-length'] ?? Buffer.byteLength(JSON.stringify(request.body ?? {})));
      return handled(request, reply, async () => {
        const out = await ingestFeedBatch(deps(), auth, parsed.data, Number.isFinite(bytes) ? bytes : 0);
        reply.status(202);
        return out;
      });
    },
  );
}
