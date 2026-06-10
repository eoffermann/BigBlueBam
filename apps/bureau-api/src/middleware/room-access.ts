/**
 * Shared helpers for Bureau room authorization.
 *
 * Used by offices/bookings/knocks/livekit route modules to keep the
 * "can this caller actually do X to this room" logic in one place.
 *
 * The org-role hierarchy mirrors board-api/src/routes/audio.routes.ts:
 *   viewer < member < admin < owner
 *
 * A room is considered accessible to a caller when ANY of the following
 * holds:
 *   - the caller is org admin or owner (always)
 *   - the caller is the room.owner_id
 *   - the room privacy is 'open' (any org member may walk in)
 *   - the room privacy is 'knock' (anyone may attempt to enter; the
 *     knock flow handles the actual gating elsewhere)
 *   - the room privacy is 'private' AND the caller has a row in
 *     bureau_room_acl for the room
 *
 * `occupant_limit` is checked at LiveKit-mint time so we don't have to
 * touch Redis here; the token mint route layers that on top by reading
 * the room.capacity column and (in a future workstream) the live Redis
 * occupancy. For now we only enforce the static auth boundary.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bureauRooms, bureauRoomAcl } from '../db/schema/bureau.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

export function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

export function isOrgAdminOrOwner(role: string): boolean {
  return roleLevel(role) >= roleLevel('admin');
}

export interface RoomAccessRecord {
  id: string;
  org_id: string;
  floor_id: string;
  type: string;
  privacy_default: string;
  capacity: number | null;
  owner_id: string | null;
  archived_at: Date | null;
}

/**
 * Load a Bureau room by id, scoped to the caller's active org. Returns
 * null when the room either doesn't exist, belongs to a different org,
 * or has been archived.
 */
export async function loadRoom(
  roomId: string,
  orgId: string,
): Promise<RoomAccessRecord | null> {
  const [room] = await db
    .select({
      id: bureauRooms.id,
      org_id: bureauRooms.org_id,
      floor_id: bureauRooms.floor_id,
      type: bureauRooms.type,
      privacy_default: bureauRooms.privacy_default,
      capacity: bureauRooms.capacity,
      owner_id: bureauRooms.owner_id,
      archived_at: bureauRooms.archived_at,
    })
    .from(bureauRooms)
    .where(and(eq(bureauRooms.id, roomId), eq(bureauRooms.org_id, orgId)))
    .limit(1);

  if (!room) return null;
  if (room.archived_at) return null;
  return room;
}

/**
 * Returns true when the caller has a private-room ACL row for this room.
 * Cheap single-row lookup; the unique index on (room_id, user_id) makes
 * this an index probe.
 */
export async function hasRoomAclEntry(
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: bureauRoomAcl.id })
    .from(bureauRoomAcl)
    .where(and(eq(bureauRoomAcl.room_id, roomId), eq(bureauRoomAcl.user_id, userId)))
    .limit(1);
  return !!row;
}

export interface RoomAccessDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether the caller may join a Bureau room. Encapsulates the
 * static-auth portion of the rule from the assignment spec:
 *   (a) room owner, OR
 *   (b) ACL row for a private room, OR
 *   (c) 'open' (or 'knock') room privacy, OR
 *   (d) org admin/owner.
 *
 * Open and knock rooms both allow the actual join; the difference is
 * UX (knock rooms surface a knock prompt in the client).
 *
 * `livePrivacy` is the Redis door-state override (see
 * presence.service.ts::getDoorState). Pass it when available so a locked
 * room (`lock_room` / `set_door` flipped to 'private') actually keeps
 * non-ACL members out — without it the lock is display-only. Owners, org
 * admins, and superusers bypass the lock by design (emergency entry).
 */
export async function evaluateRoomAccess(
  room: RoomAccessRecord,
  user: { id: string; role: string; is_superuser: boolean },
  livePrivacy?: string | null,
): Promise<RoomAccessDecision> {
  if (user.is_superuser) return { allowed: true };
  if (isOrgAdminOrOwner(user.role)) return { allowed: true };
  if (room.owner_id && room.owner_id === user.id) return { allowed: true };

  const privacy = livePrivacy ?? room.privacy_default;
  if (privacy === 'open' || privacy === 'knock') {
    return { allowed: true };
  }
  if (privacy === 'private') {
    const hasAcl = await hasRoomAclEntry(room.id, user.id);
    if (hasAcl) return { allowed: true };
    return { allowed: false, reason: 'You do not have access to this private room' };
  }
  // Unknown privacy bucket: fail closed.
  return { allowed: false, reason: 'You do not have access to this room' };
}

/**
 * Standard 404 envelope used by every Bureau route when a room can't
 * be loaded. Defined here so the message stays consistent.
 */
export function roomNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'Room not found',
      details: [],
      request_id: request.id,
    },
  });
}

export function forbidden(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
) {
  return reply.status(403).send({
    error: {
      code: 'FORBIDDEN',
      message,
      details: [],
      request_id: request.id,
    },
  });
}

export function badRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
  details: unknown[] = [],
) {
  return reply.status(400).send({
    error: {
      code: 'BAD_REQUEST',
      message,
      details,
      request_id: request.id,
    },
  });
}

export function notFound(
  request: FastifyRequest,
  reply: FastifyReply,
  message: string,
) {
  return reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message,
      details: [],
      request_id: request.id,
    },
  });
}
