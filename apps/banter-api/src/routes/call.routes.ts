import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, desc, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterCalls,
  banterCallParticipants,
  banterCallTranscripts,
  banterChannels,
  banterChannelMemberships,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireChannelMember } from '../middleware/channel-auth.js';
import { broadcastToChannel } from '../services/realtime.js';
import { generateLiveKitToken, buildRoomName } from '../services/livekit-token.js';
import { resolveLivekitWsUrl } from '../services/livekit-url.js';
import * as voiceAgent from '../services/voice-agent-client.js';

const startCallSchema = z.object({
  type: z.enum(['voice', 'video', 'huddle']),
  title: z.string().max(255).optional(),
  ai_agent_mode: z.enum(['auto', 'on', 'off']).default('auto'),
});

const callHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export default async function callRoutes(fastify: FastifyInstance) {
  // POST /v1/channels/:id/calls — start a call/huddle
  fastify.post(
    '/v1/channels/:id/calls',
    { preHandler: [requireAuth, fastify.requireCan('banter.channel_call.create'), requireScope('read_write')] },
    async (request, reply) => {
      const { id: channelId } = request.params as { id: string };
      const user = request.user!;
      const body = startCallSchema.parse(request.body);

      // Verify channel exists and user is a member
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.id, channelId),
            eq(banterChannels.org_id, user.org_id),
            eq(banterChannels.is_archived, false),
          ),
        )
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [membership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, channelId),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (!membership) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You must be a channel member to start a call',
            details: [],
            request_id: request.id,
          },
        });
      }

      // For huddles, return existing active huddle if one exists
      if (body.type === 'huddle') {
        if (!channel.allow_huddles) {
          return reply.status(400).send({
            error: {
              code: 'BAD_REQUEST',
              message: 'Huddles are not allowed in this channel',
              details: [],
              request_id: request.id,
            },
          });
        }

        const [existingHuddle] = await db
          .select()
          .from(banterCalls)
          .where(
            and(
              eq(banterCalls.channel_id, channelId),
              eq(banterCalls.type, 'huddle'),
              eq(banterCalls.status, 'active'),
            ),
          )
          .limit(1);

        if (existingHuddle) {
          // Generate a token so the user can join the existing huddle
          const token = await generateLiveKitToken({
            participantIdentity: user.id,
            participantName: user.display_name,
            roomName: existingHuddle.livekit_room_name,
          });

          return reply.send({
            data: {
              call: existingHuddle,
              token,
              livekit_url: resolveLivekitWsUrl(request),
              existing: true,
            },
          });
        }
      }

      // Create the call record
      const callId = crypto.randomUUID();
      const roomName = buildRoomName(user.org_id, channelId, callId);

      const [call] = await db
        .insert(banterCalls)
        .values({
          id: callId,
          channel_id: channelId,
          started_by: user.id,
          type: body.type,
          status: 'active',
          livekit_room_name: roomName,
          title: body.title ?? null,
          ai_agent_mode: body.ai_agent_mode,
          peak_participant_count: 1,
        })
        .returning();

      // Add the creator as first participant
      await db.insert(banterCallParticipants).values({
        call_id: callId,
        user_id: user.id,
        role: 'host',
        has_video: body.type === 'video',
      });

      // Update channel active_huddle_id if huddle
      if (body.type === 'huddle') {
        await db
          .update(banterChannels)
          .set({ active_huddle_id: callId })
          .where(eq(banterChannels.id, channelId));
      }

      // Generate LiveKit token
      const token = await generateLiveKitToken({
        participantIdentity: user.id,
        participantName: user.display_name,
        roomName,
      });

      // Spawn AI agent if mode requires it
      if (body.ai_agent_mode === 'on') {
        try {
          await voiceAgent.spawnAgent({
            call_id: callId,
            mode: 'voice',
            room_name: roomName,
          });
        } catch (err) {
          fastify.log.warn({ err }, 'Failed to spawn voice agent');
        }
      }

      broadcastToChannel(channelId, {
        type: 'call.started',
        data: {
          call,
          started_by: {
            id: user.id,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
          },
        },
        timestamp: new Date().toISOString(),
      });

      return reply.status(201).send({
        data: {
          call,
          token,
          livekit_url: resolveLivekitWsUrl(request),
          existing: false,
        },
      });
    },
  );

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

      // Verify user has access (channel belongs to their org)
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

      // Verify user is a channel member (unless superuser or org owner/admin)
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

  // POST /v1/calls/:id/join — join an active call
  fastify.post(
    '/v1/calls/:id/join',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(and(eq(banterCalls.id, id), eq(banterCalls.status, 'active')))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Active call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify user is member of the channel
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
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You must be a channel member to join this call',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Add participant record (a user may rejoin, so use the latest joined_at)
      await db.insert(banterCallParticipants).values({
        call_id: id,
        user_id: user.id,
        role: 'participant',
        has_video: call.type === 'video',
      });

      // Update peak participant count
      const [countRow] = await db
        .select({ count: sql<number>`count(DISTINCT ${banterCallParticipants.user_id})::int` })
        .from(banterCallParticipants)
        .where(
          and(eq(banterCallParticipants.call_id, id), isNull(banterCallParticipants.left_at)),
        );

      const currentCount = countRow?.count ?? 0;
      if (currentCount > call.peak_participant_count) {
        await db
          .update(banterCalls)
          .set({ peak_participant_count: currentCount })
          .where(eq(banterCalls.id, id));
      }

      // Generate LiveKit token
      const token = await generateLiveKitToken({
        participantIdentity: user.id,
        participantName: user.display_name,
        roomName: call.livekit_room_name,
      });

      broadcastToChannel(call.channel_id, {
        type: 'call.participant_joined',
        data: {
          call_id: id,
          user: {
            id: user.id,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
          },
        },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: { call, token, livekit_url: resolveLivekitWsUrl(request) } });
    },
  );

  // POST /v1/calls/:id/leave — leave a call
  fastify.post(
    '/v1/calls/:id/leave',
    { preHandler: [requireAuth, requireScope('read_write')] },
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

      // Find the most recent active participant record for this user
      const [participant] = await db
        .select()
        .from(banterCallParticipants)
        .where(
          and(
            eq(banterCallParticipants.call_id, id),
            eq(banterCallParticipants.user_id, user.id),
            isNull(banterCallParticipants.left_at),
          ),
        )
        .orderBy(desc(banterCallParticipants.joined_at))
        .limit(1);

      if (participant) {
        const now = new Date();
        const joinedAt = new Date(participant.joined_at);
        const durationSeconds = Math.floor((now.getTime() - joinedAt.getTime()) / 1000);

        await db
          .update(banterCallParticipants)
          .set({
            left_at: now,
            duration_seconds: durationSeconds,
          })
          .where(eq(banterCallParticipants.id, participant.id));

        broadcastToChannel(call.channel_id, {
          type: 'call.participant_left',
          data: {
            call_id: id,
            user_id: user.id,
          },
          timestamp: new Date().toISOString(),
        });
      }

      // Check if no active participants remain — auto-end call
      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(banterCallParticipants)
        .where(
          and(eq(banterCallParticipants.call_id, id), isNull(banterCallParticipants.left_at)),
        );

      if ((remaining?.count ?? 0) === 0 && call.status === 'active') {
        await endCallInternal(call);
      }

      return reply.send({ data: { success: true } });
    },
  );

  // POST /v1/calls/:id/end — end call for all
  fastify.post(
    '/v1/calls/:id/end',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(and(eq(banterCalls.id, id), eq(banterCalls.status, 'active')))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Active call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Only host or org admin can end the call
      const [participant] = await db
        .select()
        .from(banterCallParticipants)
        .where(
          and(
            eq(banterCallParticipants.call_id, id),
            eq(banterCallParticipants.user_id, user.id),
          ),
        )
        .limit(1);

      if (
        !['owner', 'admin'].includes(user.role) &&
        (!participant || participant.role !== 'host')
      ) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the host or an org admin can end this call',
            details: [],
            request_id: request.id,
          },
        });
      }

      await endCallInternal(call);

      return reply.send({ data: { success: true } });
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

      // Verify user has access (channel belongs to their org)
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

      // Verify user is a channel member (unless superuser or org owner/admin)
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
  // PATCH /v1/calls/:id — update call settings mid-call
  fastify.patch(
    '/v1/calls/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = z
        .object({
          recording: z.boolean().optional(),
          transcription: z.boolean().optional(),
        })
        .parse(request.body);

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(and(eq(banterCalls.id, id), eq(banterCalls.status, 'active')))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Active call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Only host or org admin can update call settings
      const [participant] = await db
        .select()
        .from(banterCallParticipants)
        .where(
          and(
            eq(banterCallParticipants.call_id, id),
            eq(banterCallParticipants.user_id, user.id),
          ),
        )
        .limit(1);

      if (
        !['owner', 'admin'].includes(user.role) &&
        (!participant || participant.role !== 'host')
      ) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the host or an org admin can update call settings',
            details: [],
            request_id: request.id,
          },
        });
      }

      const updateData: Record<string, unknown> = {};
      if (body.recording !== undefined) updateData.recording_enabled = body.recording;
      if (body.transcription !== undefined) updateData.transcription_enabled = body.transcription;

      // Start/stop recording via LiveKit Egress API
      if (body.recording !== undefined) {
        try {
          const { startRecording, stopRecording } = await import('../services/recording.js');
          if (body.recording && !call.recording_storage_key) {
            const egressId = await startRecording(
              call.livekit_room_name,
              `banter/recordings/${call.id}`,
            );
            updateData.recording_storage_key = egressId;
          } else if (!body.recording && call.recording_storage_key) {
            await stopRecording(call.recording_storage_key);
          }
        } catch (err) {
          fastify.log.warn({ err }, 'Recording toggle failed — LiveKit Egress may not be available');
          // Still update the flag in DB even if egress fails
        }
      }

      const [updated] = await db
        .update(banterCalls)
        .set(updateData)
        .where(eq(banterCalls.id, id))
        .returning();

      broadcastToChannel(call.channel_id, {
        type: 'call.updated',
        data: { call: updated },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: updated });
    },
  );

  // POST /v1/calls/:id/invite-agent — invite AI agent to a call
  fastify.post(
    '/v1/calls/:id/invite-agent',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(and(eq(banterCalls.id, id), eq(banterCalls.status, 'active')))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Active call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Verify user is a member of the channel
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
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You must be a channel member to invite an agent',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const agentInfo = await voiceAgent.spawnAgent({
          call_id: id,
          mode: 'voice',
          room_name: call.livekit_room_name,
        });

        broadcastToChannel(call.channel_id, {
          type: 'call.agent_joined',
          data: { call_id: id, agent: agentInfo },
          timestamp: new Date().toISOString(),
        });

        return reply.send({ data: { success: true, agent: agentInfo } });
      } catch (err) {
        return reply.status(500).send({
          error: {
            code: 'AGENT_ERROR',
            message: `Failed to spawn AI agent: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // POST /v1/calls/:id/remove-agent — remove AI agent from a call
  fastify.post(
    '/v1/calls/:id/remove-agent',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [call] = await db
        .select()
        .from(banterCalls)
        .where(and(eq(banterCalls.id, id), eq(banterCalls.status, 'active')))
        .limit(1);

      if (!call) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Active call not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Only host or org admin can remove agent
      const [participant] = await db
        .select()
        .from(banterCallParticipants)
        .where(
          and(
            eq(banterCallParticipants.call_id, id),
            eq(banterCallParticipants.user_id, user.id),
          ),
        )
        .limit(1);

      if (
        !['owner', 'admin'].includes(user.role) &&
        (!participant || participant.role !== 'host')
      ) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only the host or an org admin can remove the AI agent',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        await voiceAgent.despawnAgent(id);

        broadcastToChannel(call.channel_id, {
          type: 'call.agent_removed',
          data: { call_id: id },
          timestamp: new Date().toISOString(),
        });

        return reply.send({ data: { success: true } });
      } catch (err) {
        return reply.status(500).send({
          error: {
            code: 'AGENT_ERROR',
            message: `Failed to remove AI agent: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // GET /v1/calls/:id/transcript — get call transcript segments
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

      // Verify user has access (channel belongs to their org)
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

      // Verify user is a channel member (unless superuser or org owner/admin)
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

  // PATCH /v1/calls/:id/media-state — update participant's media state (mute, camera, screenshare)
  fastify.patch(
    '/v1/calls/:id/media-state',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = z
        .object({
          has_audio: z.boolean().optional(),
          has_video: z.boolean().optional(),
          has_screen_share: z.boolean().optional(),
        })
        .parse(request.body);

      // Find the active participant record
      const [participant] = await db
        .select()
        .from(banterCallParticipants)
        .where(
          and(
            eq(banterCallParticipants.call_id, id),
            eq(banterCallParticipants.user_id, user.id),
            isNull(banterCallParticipants.left_at),
          ),
        )
        .orderBy(desc(banterCallParticipants.joined_at))
        .limit(1);

      if (!participant) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'You are not an active participant in this call',
            details: [],
            request_id: request.id,
          },
        });
      }

      const updateData: Record<string, unknown> = {};
      if (body.has_audio !== undefined) updateData.has_audio = body.has_audio;
      if (body.has_video !== undefined) updateData.has_video = body.has_video;
      if (body.has_screen_share !== undefined) updateData.has_screen_share = body.has_screen_share;

      await db
        .update(banterCallParticipants)
        .set(updateData)
        .where(eq(banterCallParticipants.id, participant.id));

      // Find the call's channel to broadcast
      const [call] = await db
        .select({ channel_id: banterCalls.channel_id })
        .from(banterCalls)
        .where(eq(banterCalls.id, id))
        .limit(1);

      if (call) {
        broadcastToChannel(call.channel_id, {
          type: 'call.participant_media_changed',
          data: {
            call_id: id,
            user_id: user.id,
            ...body,
          },
          timestamp: new Date().toISOString(),
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}

// ── Internal helpers ─────────────────────────────────────────────

async function endCallInternal(call: typeof banterCalls.$inferSelect) {
  const now = new Date();
  const startedAt = new Date(call.started_at);
  const durationSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);

  // End the call
  await db
    .update(banterCalls)
    .set({
      status: 'ended',
      ended_at: now,
      duration_seconds: durationSeconds,
    })
    .where(eq(banterCalls.id, call.id));

  // Mark all remaining active participants as left
  await db
    .update(banterCallParticipants)
    .set({ left_at: now })
    .where(
      and(eq(banterCallParticipants.call_id, call.id), isNull(banterCallParticipants.left_at)),
    );

  // Clear active_huddle_id if this was a huddle
  if (call.type === 'huddle') {
    await db
      .update(banterChannels)
      .set({ active_huddle_id: null })
      .where(eq(banterChannels.id, call.channel_id));
  }

  // Despawn any AI agent
  try {
    await voiceAgent.despawnAgent(call.id);
  } catch {
    // Agent may not have been spawned
  }

  broadcastToChannel(call.channel_id, {
    type: 'call.ended',
    data: {
      call_id: call.id,
      duration_seconds: durationSeconds,
    },
    timestamp: new Date().toISOString(),
  });
}
