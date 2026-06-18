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
