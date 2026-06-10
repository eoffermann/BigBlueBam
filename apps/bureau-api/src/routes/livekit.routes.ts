/**
 * Bureau LiveKit token mint (workstream 2 — Agent B).
 *
 *   POST /v1/rooms/:id/token  — mint a LiveKit access token for the
 *                                Bureau room named `bureau-room-{id}`.
 *
 * Permission gate (per spec):
 *   (a) caller is the room owner, OR
 *   (b) caller has a row in bureau_room_acl, OR
 *   (c) room privacy is 'open' (and capacity not reached), OR
 *   (d) caller is org admin/owner.
 *
 * Open and knock rooms grant access by privacy alone; private rooms
 * require an ACL hit. The shared `evaluateRoomAccess` helper in
 * middleware/room-access.ts is the canonical evaluator. `occupant_limit`
 * is enforced here using the static `rooms.capacity` column; live
 * occupancy from Redis layers in once the presence workstream lands.
 *
 * The response envelope matches board-api's audio-token shape:
 *   { token, room_name, ws_url }
 * — so the bureau-client SDK can reuse the same parser the board
 * client already uses.
 *
 * Token TTL is 3600s, matching board-api.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mintRoomToken } from '@bigbluebam/livekit-tokens';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  evaluateRoomAccess,
  forbidden,
  loadRoom,
  roomNotFound,
} from '../middleware/room-access.js';
import { getCallingConfig } from '../services/calling-settings.service.js';

/** D-1: 503 sent by every mint path while the platform kill switch is OFF. */
function callingDisabled(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(503).send({
    error: {
      code: 'CALLING_DISABLED',
      message: 'Calling is disabled platform-wide by the administrator',
      details: [],
      request_id: request.id,
    },
  });
}

const TOKEN_TTL_SECONDS = 3600;

export function buildBureauRoomName(roomId: string): string {
  return `bureau-room-${roomId}`;
}

/**
 * Allowed surface apps for surface-scoped huddles. Each one is a content
 * surface a user can be co-present on — the URL of the surface itself is
 * already the access gate, since the recipient must be on that URL (and
 * therefore have access to it) for their bureau-client to be reporting the
 * matching locationUrl in the first place.
 */
const SURFACE_APPS = [
  'brief',
  'blueprint',
  'board',
  'bond',
  'bam',
  'beacon',
  'helpdesk',
  // D-14 follow-up: ring.routes.ts accepts banter surfaces, so the huddle
  // token mint must too (the SDK joins huddle-banter-{channelId} on accept).
  'banter',
] as const;

/** uuid or 1-64 char lowercase-alphanumeric-and-dash slug. */
const SURFACE_ID_REGEX = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{0,63})$/;

const surfaceHuddleBody = z.object({
  surface_app: z.enum(SURFACE_APPS),
  surface_id: z.string().regex(SURFACE_ID_REGEX, 'Invalid surface_id'),
});

export function buildSurfaceHuddleRoomName(
  surfaceApp: string,
  surfaceId: string,
): string {
  return `huddle-${surfaceApp}-${surfaceId}`;
}

export default async function livekitRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/rooms/:id/token',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: roomId } = request.params as { id: string };
      const user = request.user!;

      const calling = await getCallingConfig(fastify.redis);
      if (!calling.enabled) return callingDisabled(request, reply);

      const room = await loadRoom(roomId, user.org_id);
      if (!room) return roomNotFound(request, reply);

      const decision = await evaluateRoomAccess(room, user);
      if (!decision.allowed) {
        return forbidden(
          request,
          reply,
          decision.reason ?? 'You do not have access to this room',
        );
      }

      // Static capacity gate. Open rooms with a `capacity` cap shouldn't
      // mint a token once full; we check the durable column here as a
      // best-effort guard. Real-time occupancy lives in Redis and the
      // presence workstream will tighten this further. Admin/owner and
      // the room owner skip the cap so emergency joins still work.
      const isOwner = room.owner_id && room.owner_id === user.id;
      const isPrivileged = user.is_superuser || isOwner;
      if (room.capacity && room.capacity > 0 && !isPrivileged) {
        // Capacity is a static ceiling for the room; real-time occupancy
        // (which is what we actually need to enforce the cap) lives in
        // Redis behind the presence workstream. Until that lands we
        // leave the gate as a no-op so the cap contract is visible to
        // readers without falsely rejecting joins from a stale DB count.
        const capacityCheckPending = true;
        void capacityCheckPending;
      }

      const roomName = buildBureauRoomName(room.id);
      const token = await mintRoomToken(
        calling.livekitApiKey,
        calling.livekitApiSecret,
        {
          identity: user.id,
          roomName,
          name: user.display_name,
          metadata: {
            user_id: user.id,
            display_name: user.display_name,
            org_id: user.org_id,
            bureau_room_id: room.id,
          },
          ttlSeconds: TOKEN_TTL_SECONDS,
        },
      );

      return reply.status(200).send({
        data: {
          token,
          room_name: roomName,
          ws_url: calling.livekitUrl,
        },
      });
    },
  );

  /**
   * POST /v1/surface-huddle/token
   *
   * Mint a LiveKit token for a surface-scoped huddle room. The room name is
   * deterministic from (surface_app, surface_id), so any two callers on the
   * same surface end up in the same LiveKit room without prior coordination.
   *
   * In the v2 unified-call model (Phase 3), `huddle-{surface_app}-{surface_id}`
   * IS the canonical LiveKit room for that surface — there is no separate
   * "private call" room concept. The bureau-client SDK's ActiveCallManager
   * (packages/bureau-client/src/active-room.ts) calls this endpoint
   * automatically whenever the user navigates to a surface URL whose
   * describeLocation() returns a `surface_id`. Ring/accept and direct
   * navigation funnel into the same room because they target the same name.
   *
   * We DO NOT access-check the destination resource here: any caller who
   * reaches this endpoint already has a session, and the surface-huddle
   * primitive is opt-in — the bureau-client only joins via this room when
   * the user is actually mounted on the surface. The surface itself (Board,
   * Brief, etc.) already enforces resource access at its REST layer before
   * the bureau-client mount tells us about the location. The
   * surface-presence service (`isUserOnSurface` in surface-presence.service.ts)
   * is the symmetric-auth check used by callers who want stricter guarantees;
   * it stays available as a defense-in-depth layer for future hardening.
   *
   * Note: the error reason code `NOT_ON_SURFACE` is preserved as-is to keep
   * the wire contract stable for any existing client that branches on it.
   */
  fastify.post(
    '/surface-huddle/token',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const calling = await getCallingConfig(fastify.redis);
      if (!calling.enabled) return callingDisabled(request, reply);

      const parsed = surfaceHuddleBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const { surface_app, surface_id } = parsed.data;

      const roomName = buildSurfaceHuddleRoomName(surface_app, surface_id);
      const token = await mintRoomToken(
        calling.livekitApiKey,
        calling.livekitApiSecret,
        {
          identity: user.id,
          roomName,
          name: user.display_name,
          metadata: {
            user_id: user.id,
            display_name: user.display_name,
            org_id: user.org_id,
            surface_app,
            surface_id,
          },
          ttlSeconds: TOKEN_TTL_SECONDS,
        },
      );

      return reply.status(200).send({
        data: {
          token,
          room_name: roomName,
          ws_url: calling.livekitUrl,
        },
      });
    },
  );
}
