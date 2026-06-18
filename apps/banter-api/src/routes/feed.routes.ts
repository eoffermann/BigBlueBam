import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterChannels } from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { FEED_SOURCES } from '@bigbluebam/shared';
import {
  listSubscriptions,
  resolveEffectiveState,
  upsertSubscription,
  deleteSubscriptionById,
} from '../services/feed-subscriptions.service.js';
import {
  getRankedFeed,
  getFeedEntry,
  markSeen,
  dismissEntry,
  bustFeedCache,
  previewFeed,
} from '../services/feed-read.service.js';
import {
  getWeightsView,
  upsertOrgWeights,
  upsertPlatformWeights,
} from '../services/feed-weights.service.js';
import { effectiveWeights, type FeedWeightsOverride } from '@bigbluebam/shared';

/**
 * Banter Feed routes (banter-feed-design-document.md §13).
 *
 * Phase 2 surface: the subscription hierarchy CRUD and the channel-follow
 * convenience alias. The ranked read endpoints (GET /v1/feed, seen, dismiss)
 * are added in Phase 4. Kept in one file so the whole /v1/feed surface lives
 * together.
 */

const scopeTypeEnum = z.enum(['item', 'channel', 'project', 'source']);
const stateEnum = z.enum(['following', 'unfollowed', 'muted']);
const sourceEnum = z.enum(FEED_SOURCES as unknown as [string, ...string[]]);

const upsertSubscriptionSchema = z
  .object({
    scope_type: scopeTypeEnum,
    scope_source: sourceEnum,
    scope_id: z.string().uuid().nullish(),
    state: stateEnum,
  })
  .refine((v) => v.scope_type === 'source' || !!v.scope_id, {
    message: 'scope_id is required for item/channel/project scopes',
    path: ['scope_id'],
  });

const channelFollowSchema = z.object({ state: stateEnum });

const markSeenSchema = z
  .object({
    entry_ids: z.array(z.string().uuid()).max(500).optional(),
    before_seq: z.number().int().nonnegative().optional(),
  })
  .refine((v) => (v.entry_ids && v.entry_ids.length > 0) || typeof v.before_seq === 'number', {
    message: 'provide entry_ids or before_seq',
  });

// Partial weight-override shape (§8). Every field is optional so a writer can
// override just the knobs it cares about; the rest inherit.
const weightsOverrideSchema = z
  .object({
    categories: z.record(z.string(), z.number()).optional(),
    gravity: z.number().positive().optional(),
    recency_offset: z.number().nonnegative().optional(),
    engagement_weight: z.number().nonnegative().optional(),
    interaction_boost: z
      .object({
        commented: z.number(),
        reacted: z.number(),
        authored: z.number(),
        mentioned: z.number(),
      })
      .partial()
      .optional(),
    affinity_boost: z
      .object({ assignee: z.number(), watcher: z.number(), contributor: z.number() })
      .partial()
      .optional(),
    seen_multiplier: z.number().min(0).max(1).optional(),
    candidate_window_days: z.number().int().positive().max(365).optional(),
    must_see_floor: z.number().nonnegative().optional(),
  })
  .strict();

const previewSchema = z.object({
  weights: weightsOverrideSchema,
  scope: z.enum(['org', 'platform']).optional(),
});

function isOrgAdmin(role: string | undefined, isSuperuser: boolean): boolean {
  return isSuperuser || role === 'owner' || role === 'admin';
}

function validationError(request: { id: string }, issues: { field: string; issue: string }[]) {
  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: issues,
      request_id: request.id,
    },
  };
}

export default async function feedRoutes(fastify: FastifyInstance) {
  // -------------------------------------------------------------------------
  // Ranked read (§6, §13)
  // -------------------------------------------------------------------------

  // GET /v1/feed — the caller's ranked feed.
  fastify.get(
    '/v1/feed',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const q = request.query as Record<string, string | undefined>;
      const result = await getRankedFeed(
        fastify.redis,
        user.id,
        user.org_id,
        {
          limit: q.limit ? parseInt(q.limit, 10) : undefined,
          cursor: q.cursor ?? null,
          category: q.category,
          source: q.source,
          unseen: q.unseen === 'true',
          explain: q.explain === 'true',
        },
        Date.now(),
      );
      return reply.send(result);
    },
  );

  // POST /v1/feed/seen — mark entries seen (by id list or seq watermark).
  fastify.post(
    '/v1/feed/seen',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = markSeenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          ),
        );
      }
      const count = await markSeen(user.id, parsed.data);
      await bustFeedCache(fastify.redis, user.id);
      return reply.send({ data: { marked: count } });
    },
  );

  // POST /v1/feed/:entryId/dismiss — dismiss a single entry.
  fastify.post(
    '/v1/feed/:entryId/dismiss',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const { entryId } = request.params as { entryId: string };
      const ok = await dismissEntry(user.id, entryId);
      if (!ok) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Feed entry not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      await bustFeedCache(fastify.redis, user.id);
      return reply.send({ data: { success: true } });
    },
  );

  // GET /v1/feed/:entryId — a single hydrated entry (permalink view).
  fastify.get(
    '/v1/feed/:entryId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const { entryId } = request.params as { entryId: string };
      const q = request.query as Record<string, string | undefined>;
      const entry = await getFeedEntry(
        user.id,
        entryId,
        user.org_id,
        q.explain === 'true',
        Date.now(),
      );
      if (!entry) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Feed entry not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: entry });
    },
  );

  // -------------------------------------------------------------------------
  // Weights (§9, §13) — the tunable ranking knobs.
  // -------------------------------------------------------------------------

  // GET /v1/feed/weights — effective merged weights + the raw overrides.
  fastify.get(
    '/v1/feed/weights',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const view = await getWeightsView(user.org_id);
      return reply.send({ data: view });
    },
  );

  // PUT /v1/feed/weights/org — upsert this org's overrides (admin/owner/SU).
  fastify.put(
    '/v1/feed/weights/org',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      const user = request.user!;
      if (!isOrgAdmin(user.role, user.is_superuser)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Org admin or owner required',
            details: [],
            request_id: request.id,
          },
        });
      }
      const parsed = weightsOverrideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          ),
        );
      }
      const result = await upsertOrgWeights(user.org_id, parsed.data as FeedWeightsOverride, user.id);
      return reply.send({ data: result });
    },
  );

  // PUT /v1/feed/weights/platform — upsert the deployment defaults (SuperUser).
  fastify.put(
    '/v1/feed/weights/platform',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      if (!user.is_superuser) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'SuperUser required',
            details: [],
            request_id: request.id,
          },
        });
      }
      const parsed = weightsOverrideSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          ),
        );
      }
      const result = await upsertPlatformWeights(
        parsed.data as FeedWeightsOverride,
        user.id,
        user.org_id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /v1/feed/weights/preview — dry-run re-score against proposed weights.
  fastify.post(
    '/v1/feed/weights/preview',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          ),
        );
      }
      const view = await getWeightsView(user.org_id);
      const proposed = parsed.data.weights as FeedWeightsOverride;
      // Merge the proposed override at the editing level over the other level.
      const proposedEffective =
        parsed.data.scope === 'platform'
          ? effectiveWeights(proposed, view.org?.weights ?? null)
          : effectiveWeights(view.platform?.weights ?? null, proposed);
      const result = await previewFeed(user.id, proposedEffective, Date.now(), 20);
      return reply.send({ data: result.data, effective: proposedEffective });
    },
  );

  // -------------------------------------------------------------------------
  // Subscriptions CRUD (§13)
  // -------------------------------------------------------------------------

  // GET /v1/feed/subscriptions — list the caller's explicit opt-out rows.
  fastify.get(
    '/v1/feed/subscriptions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const { source } = request.query as { source?: string };
      const data = await listSubscriptions(user.id, source);
      return reply.send({ data });
    },
  );

  // PUT /v1/feed/subscriptions — upsert a subscription (follow/unfollow/mute a
  // scope). This is the "unfollow this project / mute this app / follow this
  // one board" write.
  fastify.put(
    '/v1/feed/subscriptions',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = upsertSubscriptionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
          ),
        );
      }
      const { scope_type, scope_source, scope_id, state } = parsed.data;
      const result = await upsertSubscription({
        userId: user.id,
        orgId: user.org_id,
        scopeType: scope_type,
        scopeSource: scope_source,
        scopeId: scope_id ?? null,
        state,
      });
      return reply.send({ data: { scope_type, scope_source, scope_id: scope_id ?? null, ...result } });
    },
  );

  // DELETE /v1/feed/subscriptions/:id — remove an explicit row (revert to default).
  fastify.delete(
    '/v1/feed/subscriptions/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      await deleteSubscriptionById(user.id, id);
      return reply.send({ data: { success: true } });
    },
  );

  // -------------------------------------------------------------------------
  // Channel-follow alias (§13) — a thin convenience over subscriptions so the
  // Banter channel UI does not need to know the generalized scope model.
  // -------------------------------------------------------------------------

  // GET /v1/channels/:id/follow — effective follow state for the caller.
  fastify.get(
    '/v1/channels/:id/follow',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const [channel] = await db
        .select({ id: banterChannels.id, org_id: banterChannels.org_id })
        .from(banterChannels)
        .where(eq(banterChannels.id, id))
        .limit(1);
      if (!channel || channel.org_id !== user.org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const state = await resolveEffectiveState(user.id, {
        source: 'banter',
        channelId: id,
      });
      return reply.send({ data: { channel_id: id, state } });
    },
  );

  // PUT /v1/channels/:id/follow — set following/unfollowed/muted for a channel.
  fastify.put(
    '/v1/channels/:id/follow',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const parsed = channelFollowSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(
          validationError(
            request,
            parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          ),
        );
      }

      const [channel] = await db
        .select({ id: banterChannels.id, org_id: banterChannels.org_id })
        .from(banterChannels)
        .where(eq(banterChannels.id, id))
        .limit(1);
      if (!channel || channel.org_id !== user.org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const result = await upsertSubscription({
        userId: user.id,
        orgId: user.org_id,
        scopeType: 'channel',
        scopeSource: 'banter',
        scopeId: id,
        state: parsed.data.state,
      });
      return reply.send({ data: { channel_id: id, ...result } });
    },
  );
}
