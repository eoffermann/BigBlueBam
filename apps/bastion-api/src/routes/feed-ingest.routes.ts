import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BASTION_FEED_KEY_RATE_PER_MINUTE, BASTION_FEED_MAX_BATCH_BYTES, bastionFeedBatchSchema } from '@bigbluebam/shared';
import { env } from '../env.js';
import {
  BASTION_FEED_AUTH_FAILURES_PER_IP_MINUTE,
  BASTION_FEED_PUSHES_PER_IP_MINUTE,
  countThisMinute,
  FEED_AUTH_FAIL_PREFIX,
  FEED_KEY_RATE_PREFIX,
  peekThisMinute,
  secondsToNextMinute,
} from '../lib/feed-rate.js';
import { RateLimitedError } from '../lib/errors.js';
import { handled, validationError } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import { authenticateFeedPush, FeedAuthError, ingestFeedBatch } from '../services/feeds.service.js';

type FeedAuth = Awaited<ReturnType<typeof authenticateFeedPush>>;

// Spec 5.1 row 48 (M5): POST /feeds/:feed_key/records, the machine push. NOT a user route: it has
// no session or API key and no requireCan; the caller authenticates with its per-feed key
// (`Authorization: Bearer bbf_<key_id>_<secret>`, shown once at mint, only an HMAC stored).
// Limits (spec 3.5): 2 MB per batch (route bodyLimit; larger is 413), 500 records (schema),
// 60 requests per minute per key (429), and the per-feed daily quota by UTC day (429).
//
// Pre-auth (#214): the per-IP limiter (route-level @fastify/rate-limit, before the body is read)
// runs first; an IP past its failed-authentication ceiling is refused next; and the key is checked
// in onRequest, from the headers alone, so an unauthenticated caller never gets a body parsed.
// Redis down (#225): the counters fail open with a warning (lib/feed-rate.ts).
// test/routes-permissions.test.ts checks this file separately.
export default async function feedIngestRoutes(fastify: FastifyInstance) {
  const deps = () => engineDeps(fastify.log, fastify.redis);
  const authed = new WeakMap<FastifyRequest, FeedAuth>();
  const unauthorized = (request: FastifyRequest, reply: FastifyReply) =>
    reply.status(401).send({
      error: { code: 'FEED_KEY_INVALID', message: 'This feed key is not valid for this feed.', details: [], request_id: request.id },
    });
  const tooMany = (request: FastifyRequest, reply: FastifyReply, err: RateLimitedError) =>
    handled(request, reply, () => Promise.reject(err));

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const failures = await peekThisMinute(fastify.redis, FEED_AUTH_FAIL_PREFIX, request.ip, request.log);
    if (failures >= BASTION_FEED_AUTH_FAILURES_PER_IP_MINUTE) {
      return tooMany(
        request,
        reply,
        new RateLimitedError('Too many pushes with a wrong feed key from this address. Wait a minute and try again.', 'FEED_AUTH_RATE_LIMITED', secondsToNextMinute(Date.now())),
      );
    }
    const fail = async () => {
      await countThisMinute(fastify.redis, FEED_AUTH_FAIL_PREFIX, request.ip, request.log);
      return unauthorized(request, reply);
    };
    const pathKey = String((request.params as { feed_key?: string }).feed_key ?? '');
    if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(pathKey)) return fail();
    try {
      authed.set(request, await authenticateFeedPush(deps(), pathKey, request.headers.authorization, env.BASTION_FEED_KEY_PEPPER));
    } catch (err) {
      if (err instanceof FeedAuthError) return fail();
      return handled(request, reply, () => Promise.reject(err));
    }
  }

  fastify.post(
    '/feeds/:feed_key/records',
    {
      bodyLimit: BASTION_FEED_MAX_BATCH_BYTES,
      config: { rateLimit: { max: BASTION_FEED_PUSHES_PER_IP_MINUTE, timeWindow: 60_000 } },
      onRequest: authenticate,
    },
    async (request, reply) => {
      const auth = authed.get(request);
      if (!auth) return unauthorized(request, reply);

      // 60 requests per minute per key, counted in Redis so every bastion-api instance agrees.
      const count = await countThisMinute(fastify.redis, FEED_KEY_RATE_PREFIX, auth.keyRowId, request.log);
      if (count !== null && count > BASTION_FEED_KEY_RATE_PER_MINUTE) {
        return tooMany(
          request,
          reply,
          new RateLimitedError(`This key may push at most ${BASTION_FEED_KEY_RATE_PER_MINUTE} batches a minute.`, 'FEED_KEY_RATE_LIMITED', secondsToNextMinute(Date.now())),
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
