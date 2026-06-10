/**
 * Banter call routes — Phase 2 unified-LiveKit cleanup.
 *
 * Banter no longer owns its own per-channel calling stack. All live audio/
 * video for a Banter channel is handled by the suite-wide Bureau docked-box
 * (the single LiveKit endpoint each user has on every page). The docked
 * box derives the canonical room name `huddle-banter-{channel_id}` from
 * the user's current surface, mints a token via
 * `POST /bureau/api/v1/surface-huddle/token`, and connects directly to
 * LiveKit. Two users viewing the same channel land in the same room with
 * no Banter-side signaling.
 *
 * What's still here:
 *   • GET /v1/channels/:id/calls       — call history (historical readback)
 *   • GET /v1/calls/:id                — call detail with participants
 *   • GET /v1/calls/:id/participants   — participant list
 *   • GET /v1/calls/:id/transcript     — transcript segments
 *
 * What's gone (HTTP 410 Gone):
 *   • POST   /v1/channels/:id/calls           start-call
 *   • POST   /v1/calls/:id/join               join-call
 *   • POST   /v1/calls/:id/leave              leave-call
 *   • POST   /v1/calls/:id/end                end-call
 *   • PATCH  /v1/calls/:id                    recording/transcription toggles
 *   • POST   /v1/calls/:id/invite-agent       voice-agent invite
 *   • POST   /v1/calls/:id/remove-agent       voice-agent removal
 *   • PATCH  /v1/calls/:id/media-state        mute / camera / screenshare
 *
 * The banter_calls / banter_call_participants / banter_call_transcripts
 * schema is intentionally retained so historical rows stay queryable via
 * the GET endpoints above. New historical rows for surface huddles (if
 * any) are written by the worker, not by this route file.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  banterCalls,
  banterCallParticipants,
  banterCallTranscripts,
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { requireChannelMember } from '../middleware/channel-auth.js';

const callHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const GONE_HEADERS = {
  // Hint to API clients that the resource is permanently retired.
  // The replacement is the Bureau docked-box; there is no Banter-side
  // replacement URL because the docked-box is mounted by the SDK in
  // every host SPA and operates entirely client-side against bureau-api.
  'X-Deprecated-Replacement': 'bureau-docked-box',
} as const;

function gone(reply: FastifyReply, request: FastifyRequest) {
  return reply.status(410).headers(GONE_HEADERS).send({
    error: {
      code: 'GONE',
      message:
        'Banter no longer owns voice/video calls. The suite-wide Bureau ' +
        'docked-box now handles audio for whichever channel you are ' +
        'viewing — see `huddle-banter-{channel_id}` and ' +
        'POST /bureau/api/v1/surface-huddle/token.',
      details: [],
      request_id: request.id,
    },
  });
}

export default async function callRoutes(fastify: FastifyInstance) {
  // ── Removed write endpoints (HTTP 410 Gone) ────────────────────────
  // These intentionally return 410 instead of 404 so legacy clients get a
  // clear "this is gone, not missing" signal. Auth is still required so
  // unauthenticated callers don't learn the URL surface from a 410.
  fastify.post(
    '/v1/channels/:id/calls',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.post(
    '/v1/calls/:id/join',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.post(
    '/v1/calls/:id/leave',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.post(
    '/v1/calls/:id/end',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.patch(
    '/v1/calls/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.post(
    '/v1/calls/:id/invite-agent',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.post(
    '/v1/calls/:id/remove-agent',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );
  fastify.patch(
    '/v1/calls/:id/media-state',
    { preHandler: [requireAuth] },
    async (request, reply) => gone(reply, request),
  );

  // ── Retained read endpoints ────────────────────────────────────────
  // These read historical rows out of banter_calls / *_participants /
  // *_transcripts. They are not coupled to the live LiveKit stack.

  // GET /v1/channels/:id/calls — call history
  fastify.get(
    '/v1/channels/:id/calls',
    { preHandler: [requireAuth, requireChannelMember] },
    async (request, reply) => {
      const { id: channelId } = request.params as { id: string };
      const params = callHistorySchema.parse(request.query);

      const calls = await db
        .select()
        .from(banterCalls)
        .where(eq(banterCalls.channel_id, channelId))
        .orderBy(desc(banterCalls.started_at))
        .limit(params.limit)
        .offset(params.offset);

      return reply.send({ data: calls });
    },
  );

  // GET /v1/calls/:id — call detail with participants
  fastify.get(
    '/v1/calls/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(eq(banterCalls.id, id))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(and(eq(banterChannels.id, call.channel_id), eq(banterChannels.org_id, user.org_id)))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!user.is_superuser && !['owner', 'admin'].includes(user.role)) {
        const [membership] = await db
          .select()
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, call.channel_id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Call not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const participants = await db
        .select({
          id: banterCallParticipants.id,
          user_id: banterCallParticipants.user_id,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          role: banterCallParticipants.role,
          joined_at: banterCallParticipants.joined_at,
          left_at: banterCallParticipants.left_at,
          has_audio: banterCallParticipants.has_audio,
          has_video: banterCallParticipants.has_video,
          has_screen_share: banterCallParticipants.has_screen_share,
          is_bot: banterCallParticipants.is_bot,
          participation_mode: banterCallParticipants.participation_mode,
        })
        .from(banterCallParticipants)
        .innerJoin(users, eq(banterCallParticipants.user_id, users.id))
        .where(eq(banterCallParticipants.call_id, id))
        .orderBy(banterCallParticipants.joined_at);

      return reply.send({
        data: {
          ...call,
          channel_name: channel.name,
          participants,
        },
      });
    },
  );

  // GET /v1/calls/:id/participants — list participants
  fastify.get(
    '/v1/calls/:id/participants',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(eq(banterCalls.id, id))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(and(eq(banterChannels.id, call.channel_id), eq(banterChannels.org_id, user.org_id)))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!user.is_superuser && !['owner', 'admin'].includes(user.role)) {
        const [membership] = await db
          .select()
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, call.channel_id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Call not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const participants = await db
        .select({
          id: banterCallParticipants.id,
          user_id: banterCallParticipants.user_id,
          display_name: users.display_name,
          avatar_url: users.avatar_url,
          role: banterCallParticipants.role,
          joined_at: banterCallParticipants.joined_at,
          left_at: banterCallParticipants.left_at,
          duration_seconds: banterCallParticipants.duration_seconds,
          has_audio: banterCallParticipants.has_audio,
          has_video: banterCallParticipants.has_video,
          has_screen_share: banterCallParticipants.has_screen_share,
          is_bot: banterCallParticipants.is_bot,
          participation_mode: banterCallParticipants.participation_mode,
        })
        .from(banterCallParticipants)
        .innerJoin(users, eq(banterCallParticipants.user_id, users.id))
        .where(eq(banterCallParticipants.call_id, id))
        .orderBy(banterCallParticipants.joined_at);

      return reply.send({ data: participants });
    },
  );

  // GET /v1/calls/:id/transcript — historical transcript segments
  fastify.get(
    '/v1/calls/:id/transcript',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(eq(banterCalls.id, id))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(and(eq(banterChannels.id, call.channel_id), eq(banterChannels.org_id, user.org_id)))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!user.is_superuser && !['owner', 'admin'].includes(user.role)) {
        const [membership] = await db
          .select()
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, call.channel_id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Call not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const segments = await db
        .select({
          id: banterCallTranscripts.id,
          call_id: banterCallTranscripts.call_id,
          speaker_id: banterCallTranscripts.speaker_id,
          speaker_name: users.display_name,
          speaker_avatar_url: users.avatar_url,
          content: banterCallTranscripts.content,
          started_at: banterCallTranscripts.started_at,
          ended_at: banterCallTranscripts.ended_at,
          confidence: banterCallTranscripts.confidence,
          is_final: banterCallTranscripts.is_final,
        })
        .from(banterCallTranscripts)
        .innerJoin(users, eq(banterCallTranscripts.speaker_id, users.id))
        .where(eq(banterCallTranscripts.call_id, id))
        .orderBy(banterCallTranscripts.started_at);

      return reply.send({ data: segments });
    },
  );
}
