import type { FastifyInstance } from 'fastify';
import {
  bastionFeedCreateSchema,
  bastionFeedKeyCreateSchema,
  bastionFeedRecordListQuerySchema,
  bastionFeedUpdateSchema,
} from '@bigbluebam/shared';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { engineDeps } from '../engine/runtime.js';
import * as feeds from '../services/feeds.service.js';

// Spec 5.1 rows 42-47 and 49 (M5): feed configuration, keys, and record inspection. The machine
// push itself (row 48) authenticates with its own per-feed key and lives in feed-ingest.routes.ts.
export default async function feedRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => engineDeps(fastify.log, fastify.redis);

  // Row 42.
  fastify.get('/feeds', { preHandler: [requireAuth, can('bastion.feed.read')] }, async (request, reply) => {
    return handled(request, reply, () => feeds.listFeeds(deps(), viewerOf(request)));
  });

  // Row 43.
  fastify.post('/feeds', { preHandler: [requireAuth, can('bastion.feed.manage')] }, async (request, reply) => {
    const parsed = bastionFeedCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await feeds.createFeed(deps(), viewerOf(request), parsed.data);
      reply.status(201);
      return out;
    });
  });

  // Row 44.
  fastify.patch('/feeds/:id', { preHandler: [requireAuth, can('bastion.feed.manage')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionFeedUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => feeds.updateFeed(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 45.
  fastify.get('/feeds/:id/keys', { preHandler: [requireAuth, can('bastion.feed.manage')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => feeds.listFeedKeys(deps(), viewerOf(request), id));
  });

  // Row 46: the token is in this response only.
  fastify.post('/feeds/:id/keys', { preHandler: [requireAuth, can('bastion.feed.manage')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionFeedKeyCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await feeds.createFeedKey(deps(), viewerOf(request), id, parsed.data, env.BASTION_FEED_KEY_PEPPER);
      reply.status(201);
      return out;
    });
  });

  // Row 47.
  fastify.post('/feed-keys/:id/revoke', { preHandler: [requireAuth, can('bastion.feed.manage')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => feeds.revokeFeedKey(deps(), viewerOf(request), id));
  });

  // Row 49.
  // `asker_user_id` (#217): record subjects are personal data; the asker must hold feed.read too.
  fastify.get('/feeds/:id/records', { preHandler: [requireAuth, can('bastion.feed.read'), fastify.requireAskerCan('bastion.feed.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const raw = request.query as Record<string, string | undefined>;
    const parsed = bastionFeedRecordListQuerySchema.safeParse({ limit: raw.limit || undefined, before: raw.before || undefined });
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => feeds.listFeedRecords(deps(), viewerOf(request), id, parsed.data));
  });
}
