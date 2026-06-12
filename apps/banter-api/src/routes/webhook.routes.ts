import type { FastifyInstance } from 'fastify';
import { eq, and, sql, isNull, desc } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { db } from '../db/index.js';
import {
  banterCalls,
  banterCallParticipants,
  banterChannels,
  banterSettings,
} from '../db/schema/index.js';
import { broadcastToChannel } from '../services/realtime.js';
import {
  broadcastPresenceChange,
  enterCall,
  getUserOrgId,
  leaveCall,
} from '../services/presence.service.js';
import {
  extractUserIdFromLiveKitIdentity,
  parseAppRoomName,
} from '@bigbluebam/livekit-tokens';

/**
 * LiveKit webhook events.
 * See: https://docs.livekit.io/realtime/server/webhooks/
 */
interface LiveKitWebhookEvent {
  event: string;
  room?: {
    name: string;
    sid: string;
    numParticipants?: number;
  };
  participant?: {
    identity: string;
    sid: string;
    name?: string;
  };
  id?: string;
  createdAt?: number;
}

/**
 * Verify LiveKit webhook signature.
 *
 * LiveKit signs webhooks by issuing a JWT in the Authorization header
 * using the API secret as the HMAC-SHA256 signing key. We:
 *   1. Extract the Bearer token from the Authorization header.
 *   2. Parse the room name from the webhook body to find the owning org
 *      via parseAppRoomName(). This is O(1) — single org lookup, no
 *      table scan. The legacy `banter_…` room format is recognized too,
 *      so this transition is non-breaking for in-flight calls.
 *   3. Look up that org's livekit_api_secret and verify HMAC-SHA256.
 *   4. If lookup fails (room name doesn't parse, no settings row), fall
 *      back to scanning all org secrets — preserves the historical
 *      behavior for any room name shape we haven't accounted for yet.
 */
async function verifyLiveKitSignature(
  authHeader: string | undefined,
  body: unknown,
  logger: FastifyInstance['log'],
): Promise<boolean> {
  if (!authHeader) {
    logger.warn('LiveKit webhook: no Authorization header present');
    return false;
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    logger.warn('LiveKit webhook: Authorization header has no token');
    return false;
  }

  // Decode JWT parts (header.payload.signature)
  const parts = token.split('.');
  if (parts.length !== 3) {
    logger.warn('LiveKit webhook: malformed JWT token');
    return false;
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signatureB64 = parts[2]!;
  const base64urlDecode = (str: string): Buffer =>
    Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const receivedSig = base64urlDecode(signatureB64);

  // Try the room-name-prefix path first. If the room name encodes the
  // orgId (new format or legacy banter format), we can verify in O(1).
  const roomName = (body as { room?: { name?: string } } | undefined)?.room?.name;
  const parsed = roomName ? parseAppRoomName(roomName) : null;
  if (parsed?.orgId) {
    const [row] = await db
      .select({ livekit_api_secret: banterSettings.livekit_api_secret })
      .from(banterSettings)
      .where(eq(banterSettings.org_id, parsed.orgId))
      .limit(1);
    const secret = row?.livekit_api_secret;
    if (secret) {
      const expectedSig = createHmac('sha256', secret).update(signingInput).digest();
      if (expectedSig.length === receivedSig.length && expectedSig.equals(receivedSig)) {
        return true;
      }
      // The room is owned by this org but the signature didn't match.
      // Fall through to the broad scan below — possible the org has
      // rotated secrets and the webhook is signed with the previous one.
      logger.warn(
        { orgId: parsed.orgId },
        'LiveKit webhook: org-scoped secret mismatch, falling back to broad scan',
      );
    }
  }

  // Fallback: scan every configured secret. Historical behavior; kept
  // for the case where a webhook arrives with a room name we don't
  // recognize (new format added in another app, etc).
  const settingsRows = await db
    .select({ livekit_api_secret: banterSettings.livekit_api_secret })
    .from(banterSettings)
    .where(sql`${banterSettings.livekit_api_secret} IS NOT NULL AND ${banterSettings.livekit_api_secret} != ''`);

  if (settingsRows.length === 0) {
    logger.warn('LiveKit webhook: no livekit_api_secret configured in any org settings');
    return false;
  }

  for (const row of settingsRows) {
    const secret = row.livekit_api_secret;
    if (!secret) continue;
    const expectedSig = createHmac('sha256', secret).update(signingInput).digest();
    if (expectedSig.length === receivedSig.length && expectedSig.equals(receivedSig)) {
      return true;
    }
  }

  logger.warn('LiveKit webhook: JWT signature did not match any configured API secret');
  return false;
}

/**
 * Check whether any org has a LiveKit API secret configured.
 * Used to decide whether to enforce signature verification.
 */
async function hasAnyLiveKitSecret(): Promise<boolean> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(banterSettings)
    .where(sql`${banterSettings.livekit_api_secret} IS NOT NULL AND ${banterSettings.livekit_api_secret} != ''`);
  return (rows[0]?.count ?? 0) > 0;
}

export default async function webhookRoutes(fastify: FastifyInstance) {
  // POST /v1/webhooks/livekit — receives LiveKit room events
  fastify.post('/v1/webhooks/livekit', async (request, reply) => {
    // Verify webhook signature
    const authHeader = request.headers.authorization;
    const signatureValid = await verifyLiveKitSignature(authHeader, request.body, fastify.log);
    if (!signatureValid) {
      // Check if any LiveKit API secret is configured — if so, reject unverified webhooks.
      // Only allow unverified webhooks when no secret is configured (dev mode).
      const hasConfiguredSecret = await hasAnyLiveKitSecret();
      if (hasConfiguredSecret) {
        fastify.log.error(
          'LiveKit webhook: signature verification failed with a configured API secret — rejecting',
        );
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'LiveKit webhook signature verification failed',
            details: [],
            request_id: request.id,
          },
        });
      }
      fastify.log.warn(
        'LiveKit webhook: no API secret configured — proceeding without signature verification (dev mode)',
      );
    }

    const event = request.body as LiveKitWebhookEvent;

    if (!event?.event) {
      return reply.status(400).send({ error: 'Missing event type' });
    }

    const roomName = event.room?.name;
    if (!roomName) {
      return reply.status(200).send({ ok: true });
    }

    fastify.log.info({ event: event.event, room: roomName }, 'LiveKit webhook received');

    switch (event.event) {
      case 'room_started':
        await handleRoomStarted(event);
        break;
      case 'participant_joined':
        await handleParticipantJoined(event);
        break;
      case 'participant_left':
        await handleParticipantLeft(event, fastify);
        break;
      case 'room_finished':
        await handleRoomFinished(event);
        break;
      default:
        fastify.log.debug({ event: event.event }, 'Unhandled LiveKit webhook event');
    }

    return reply.status(200).send({ ok: true });
  });
}

// ── Event handlers ───────────────────────────────────────────────

async function handleRoomStarted(event: LiveKitWebhookEvent) {
  const roomName = event.room!.name;
  const roomSid = event.room!.sid;

  // Update call record with the LiveKit room SID
  await db
    .update(banterCalls)
    .set({ livekit_room_sid: roomSid })
    .where(eq(banterCalls.livekit_room_name, roomName));
}

async function handleParticipantJoined(event: LiveKitWebhookEvent) {
  const roomName = event.room!.name;
  const rawIdentity = event.participant?.identity;
  if (!rawIdentity) return;
  // LiveKit identities are now per-session (`<userId>__<rand>`). Strip
  // the suffix to recover the canonical user_id used in DB rows.
  const participantIdentity = extractUserIdFromLiveKitIdentity(rawIdentity);

  // Find the call
  const [call] = await db
    .select()
    .from(banterCalls)
    .where(
      and(eq(banterCalls.livekit_room_name, roomName), eq(banterCalls.status, 'active')),
    )
    .limit(1);

  if (!call) return;

  // Check if participant already has an active record
  const [existing] = await db
    .select()
    .from(banterCallParticipants)
    .where(
      and(
        eq(banterCallParticipants.call_id, call.id),
        eq(banterCallParticipants.user_id, participantIdentity),
        isNull(banterCallParticipants.left_at),
      ),
    )
    .limit(1);

  if (!existing) {
    // Insert participant record (may have been created by join endpoint already)
    try {
      await db.insert(banterCallParticipants).values({
        call_id: call.id,
        user_id: participantIdentity,
        role: 'participant',
      });
    } catch {
      // Ignore constraint violations
    }
  }

  // Update peak count
  const [countRow] = await db
    .select({ count: sql<number>`count(DISTINCT ${banterCallParticipants.user_id})::int` })
    .from(banterCallParticipants)
    .where(
      and(
        eq(banterCallParticipants.call_id, call.id),
        isNull(banterCallParticipants.left_at),
      ),
    );

  const currentCount = countRow?.count ?? 0;
  if (currentCount > call.peak_participant_count) {
    await db
      .update(banterCalls)
      .set({ peak_participant_count: currentCount })
      .where(eq(banterCalls.id, call.id));
  }

  // Flip the user's presence to in_call and broadcast (fire-and-forget).
  (async () => {
    try {
      const row = await enterCall(participantIdentity, call.channel_id);
      const orgId = await getUserOrgId(participantIdentity);
      if (orgId) broadcastPresenceChange(orgId, row);
    } catch {
      // Non-critical: presence is best-effort
    }
  })();
}

async function handleParticipantLeft(
  event: LiveKitWebhookEvent,
  _fastify: FastifyInstance,
) {
  const roomName = event.room!.name;
  const rawIdentity = event.participant?.identity;
  if (!rawIdentity) return;
  const participantIdentity = extractUserIdFromLiveKitIdentity(rawIdentity);

  const [call] = await db
    .select()
    .from(banterCalls)
    .where(eq(banterCalls.livekit_room_name, roomName))
    .limit(1);

  if (!call) return;

  // Find the participant's active record
  const [participant] = await db
    .select()
    .from(banterCallParticipants)
    .where(
      and(
        eq(banterCallParticipants.call_id, call.id),
        eq(banterCallParticipants.user_id, participantIdentity),
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
      .set({ left_at: now, duration_seconds: durationSeconds })
      .where(eq(banterCallParticipants.id, participant.id));

    broadcastToChannel(call.channel_id, {
      type: 'call.participant_left',
      data: { call_id: call.id, user_id: participantIdentity },
      timestamp: new Date().toISOString(),
    });

    // Demote presence from in_call back to online (fire-and-forget).
    (async () => {
      try {
        const row = await leaveCall(participantIdentity);
        const orgId = await getUserOrgId(participantIdentity);
        if (orgId) broadcastPresenceChange(orgId, row);
      } catch {
        // Non-critical: presence is best-effort
      }
    })();
  }
}

async function handleRoomFinished(event: LiveKitWebhookEvent) {
  const roomName = event.room!.name;

  const [call] = await db
    .select()
    .from(banterCalls)
    .where(
      and(eq(banterCalls.livekit_room_name, roomName), eq(banterCalls.status, 'active')),
    )
    .limit(1);

  if (!call) return;

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

  // Mark all remaining participants as left
  await db
    .update(banterCallParticipants)
    .set({ left_at: now })
    .where(
      and(eq(banterCallParticipants.call_id, call.id), isNull(banterCallParticipants.left_at)),
    );

  // Clear active_huddle_id if huddle
  if (call.type === 'huddle') {
    await db
      .update(banterChannels)
      .set({ active_huddle_id: null })
      .where(eq(banterChannels.id, call.channel_id));
  }

  broadcastToChannel(call.channel_id, {
    type: 'call.ended',
    data: { call_id: call.id, duration_seconds: durationSeconds },
    timestamp: new Date().toISOString(),
  });
}
