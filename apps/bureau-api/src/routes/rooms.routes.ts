import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  bureauFloors,
  bureauRooms,
  bureauRoomAcl,
  bureauSettings,
} from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';
import { layoutZoneIds } from '../services/floor-layout.service.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

function isOrgAdminOrOwner(role: string): boolean {
  return roleLevel(role) >= roleLevel('admin');
}

const ROOM_TYPES = [
  'office',
  'huddle',
  'conference',
  'meeting',
  'open',
  'lounge',
  'focus',
  'lobby',
] as const;

const PRIVACY_VALUES = ['open', 'knock', 'private'] as const;
const ACL_ROLES = ['member', 'manager'] as const;

const createRoomBody = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(ROOM_TYPES),
  floor_id: z.string().uuid(),
  capacity: z.number().int().min(1).nullable().optional(),
  privacy_default: z.enum(PRIVACY_VALUES).optional(),
  bookable: z.boolean().optional(),
  zone_id: z.string().min(1).max(64),
  owner_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateRoomBody = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.enum(ROOM_TYPES).optional(),
  capacity: z.number().int().min(1).nullable().optional(),
  privacy_default: z.enum(PRIVACY_VALUES).optional(),
  bookable: z.boolean().optional(),
  zone_id: z.string().min(1).max(64).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const aclUpsertBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(ACL_ROLES),
});

const doorBody = z.object({
  privacy: z.enum(PRIVACY_VALUES),
});

// Rejection helper for room create/update with a zone_id that is not in
// the floor layout (see layoutZoneIds for the full rationale).
function unknownZoneReply(
  reply: FastifyReply,
  requestId: string,
  zoneId: string,
  valid: Set<string>,
) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: `zone_id "${zoneId}" is not a zone in this floor's layout`,
      details: [
        {
          field: 'zone_id',
          issue: `must be one of the floor's layout zones: ${[...valid].slice(0, 20).join(', ')}`,
        },
      ],
      request_id: requestId,
    },
  });
}

/**
 * Read live occupants set for a room from Redis.
 * Returns [] if Redis not yet populated (workstream 3 owns presence).
 */
async function readRoomOccupants(
  fastify: FastifyInstance,
  roomId: string,
): Promise<string[]> {
  try {
    return await fastify.redis.smembers(`bureau:room:${roomId}:occupants`);
  } catch (err) {
    fastify.log.warn({ err, room_id: roomId }, 'Failed to read room occupants from Redis');
    return [];
  }
}

/**
 * Look up a user's ACL role for a room, if any.
 */
async function getAclRole(
  roomId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: bureauRoomAcl.role })
    .from(bureauRoomAcl)
    .where(and(eq(bureauRoomAcl.room_id, roomId), eq(bureauRoomAcl.user_id, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Fetch an org-scoped, non-archived room. Returns null if not found.
 */
async function fetchOrgRoom(
  orgId: string,
  roomId: string,
): Promise<typeof bureauRooms.$inferSelect | null> {
  const [room] = await db
    .select()
    .from(bureauRooms)
    .where(
      and(
        eq(bureauRooms.id, roomId),
        eq(bureauRooms.org_id, orgId),
        isNull(bureauRooms.archived_at),
      ),
    )
    .limit(1);
  return room ?? null;
}

const listRoomsQuery = z.object({
  // '1' restricts to bookable rooms (the booking screen's default view).
  bookable: z.union([z.literal('1'), z.literal('0')]).optional(),
  floor_id: z.string().uuid().optional(),
});

export default async function roomsRoutes(fastify: FastifyInstance) {
  // GET /v1/rooms — list org rooms (live, non-archived), joined with floor
  // name and live occupancy. ?bookable=1 restricts to reservable rooms;
  // ?floor_id=<uuid> restricts to one floor. Backs the room-booking screen
  // (it needs the bookable flag + floor name, which the floor-detail room
  // summary intentionally omits).
  fastify.get(
    '/rooms',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const parsed = listRoomsQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const conditions = [
        eq(bureauRooms.org_id, user.org_id),
        isNull(bureauRooms.archived_at),
        isNull(bureauFloors.archived_at),
      ];
      if (parsed.data.bookable === '1') {
        conditions.push(eq(bureauRooms.bookable, true));
      }
      if (parsed.data.floor_id) {
        conditions.push(eq(bureauRooms.floor_id, parsed.data.floor_id));
      }

      const rows = await db
        .select({
          id: bureauRooms.id,
          floor_id: bureauRooms.floor_id,
          floor_name: bureauFloors.name,
          name: bureauRooms.name,
          type: bureauRooms.type,
          privacy_default: bureauRooms.privacy_default,
          capacity: bureauRooms.capacity,
          bookable: bureauRooms.bookable,
          zone_id: bureauRooms.zone_id,
          owner_id: bureauRooms.owner_id,
        })
        .from(bureauRooms)
        .innerJoin(bureauFloors, eq(bureauFloors.id, bureauRooms.floor_id))
        .where(and(...conditions));

      return reply.send({ data: rows });
    },
  );

  // GET /v1/rooms/:id — room detail + occupants
  fastify.get(
    '/rooms/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const occupants = await readRoomOccupants(fastify, id);

      return reply.send({
        data: {
          ...room,
          occupants,
        },
      });
    },
  );

  // POST /v1/rooms — create room.
  // Admin/owner OR (if bureau_settings.members_can_create_rooms) members.
  fastify.post(
    '/rooms',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const body = createRoomBody.parse(request.body);

      // Check creation permission
      const isAdmin = user.is_superuser || isOrgAdminOrOwner(user.role);
      if (!isAdmin) {
        // Check the bureau_settings.members_can_create_rooms flag
        const [settings] = await db
          .select({ members_can_create_rooms: bureauSettings.members_can_create_rooms })
          .from(bureauSettings)
          .where(eq(bureauSettings.org_id, user.org_id))
          .limit(1);

        // If no settings row exists, fall back to the schema default (false).
        const allowMembers = settings?.members_can_create_rooms ?? false;
        if (!allowMembers) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Member room creation is disabled by this org',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // Verify the floor exists and belongs to this org
      const [floor] = await db
        .select({ id: bureauFloors.id, layout: bureauFloors.layout })
        .from(bureauFloors)
        .where(
          and(
            eq(bureauFloors.id, body.floor_id),
            eq(bureauFloors.org_id, user.org_id),
            isNull(bureauFloors.archived_at),
          ),
        )
        .limit(1);

      if (!floor) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Floor not found',
            details: [{ field: 'floor_id', issue: 'not found in this org' }],
            request_id: request.id,
          },
        });
      }

      const zoneIds = layoutZoneIds(floor.layout);
      if (zoneIds && !zoneIds.has(body.zone_id)) {
        return unknownZoneReply(reply, request.id, body.zone_id, zoneIds);
      }

      const [room] = await db
        .insert(bureauRooms)
        .values({
          org_id: user.org_id,
          floor_id: body.floor_id,
          name: body.name,
          type: body.type,
          privacy_default: body.privacy_default ?? 'open',
          capacity: body.capacity ?? null,
          bookable: body.bookable ?? false,
          zone_id: body.zone_id,
          owner_id: body.owner_id ?? null,
          metadata: (body.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();

      return reply.status(201).send({ data: room });
    },
  );

  // PATCH /v1/rooms/:id — update room.
  // Admin/owner OR room owner (offices) OR room manager (via bureau_room_acl).
  fastify.patch(
    '/rooms/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = updateRoomBody.parse(request.body);

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const isAdmin = user.is_superuser || isOrgAdminOrOwner(user.role);
      const isOwner = room.type === 'office' && room.owner_id === user.id;

      let isManager = false;
      if (!isAdmin && !isOwner) {
        const aclRole = await getAclRole(id, user.id);
        isManager = aclRole === 'manager';
      }

      if (!isAdmin && !isOwner && !isManager) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have permission to update this room',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (body.zone_id !== undefined && body.zone_id !== room.zone_id) {
        const [floorRow] = await db
          .select({ layout: bureauFloors.layout })
          .from(bureauFloors)
          .where(eq(bureauFloors.id, room.floor_id))
          .limit(1);
        const zoneIds = layoutZoneIds(floorRow?.layout);
        if (zoneIds && !zoneIds.has(body.zone_id)) {
          return unknownZoneReply(reply, request.id, body.zone_id, zoneIds);
        }
      }

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.type !== undefined) updates.type = body.type;
      if (body.capacity !== undefined) updates.capacity = body.capacity;
      if (body.privacy_default !== undefined) updates.privacy_default = body.privacy_default;
      if (body.bookable !== undefined) updates.bookable = body.bookable;
      if (body.zone_id !== undefined) updates.zone_id = body.zone_id;
      if (body.owner_id !== undefined) updates.owner_id = body.owner_id;
      if (body.metadata !== undefined) updates.metadata = body.metadata;

      const [updated] = await db
        .update(bureauRooms)
        .set(updates)
        .where(eq(bureauRooms.id, id))
        .returning();

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/rooms/:id — soft-delete. Admin/owner only.
  fastify.delete(
    '/rooms/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can delete rooms',
            details: [],
            request_id: request.id,
          },
        });
      }

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db
        .update(bureauRooms)
        .set({ archived_at: new Date(), updated_at: new Date() })
        .where(eq(bureauRooms.id, id));

      return reply.status(204).send();
    },
  );

  // POST /v1/rooms/:id/acl — add or update ACL entry.
  // Admin/owner OR room manager.
  fastify.post(
    '/rooms/:id/acl',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = aclUpsertBody.parse(request.body);

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const isAdmin = user.is_superuser || isOrgAdminOrOwner(user.role);
      let isManager = false;
      if (!isAdmin) {
        const aclRole = await getAclRole(id, user.id);
        isManager = aclRole === 'manager';
      }

      if (!isAdmin && !isManager) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins/owners or room managers can manage ACL entries',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Upsert: check for an existing entry, then insert or update.
      const [existing] = await db
        .select({ id: bureauRoomAcl.id })
        .from(bureauRoomAcl)
        .where(
          and(
            eq(bureauRoomAcl.room_id, id),
            eq(bureauRoomAcl.user_id, body.user_id),
          ),
        )
        .limit(1);

      let entry;
      if (existing) {
        [entry] = await db
          .update(bureauRoomAcl)
          .set({ role: body.role })
          .where(eq(bureauRoomAcl.id, existing.id))
          .returning();
      } else {
        [entry] = await db
          .insert(bureauRoomAcl)
          .values({
            room_id: id,
            user_id: body.user_id,
            role: body.role,
          })
          .returning();
      }

      return reply.status(existing ? 200 : 201).send({ data: entry });
    },
  );

  // DELETE /v1/rooms/:id/acl/:userId — remove ACL entry.
  // Admin/owner OR room manager.
  fastify.delete(
    '/rooms/:id/acl/:userId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const user = request.user!;

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const isAdmin = user.is_superuser || isOrgAdminOrOwner(user.role);
      let isManager = false;
      if (!isAdmin) {
        const aclRole = await getAclRole(id, user.id);
        isManager = aclRole === 'manager';
      }

      if (!isAdmin && !isManager) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins/owners or room managers can manage ACL entries',
            details: [],
            request_id: request.id,
          },
        });
      }

      const deleted = await db
        .delete(bureauRoomAcl)
        .where(
          and(
            eq(bureauRoomAcl.room_id, id),
            eq(bureauRoomAcl.user_id, userId),
          ),
        )
        .returning({ id: bureauRoomAcl.id });

      if (deleted.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'ACL entry not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.status(204).send();
    },
  );

  // PATCH /v1/rooms/:id/door — set door/privacy.
  // Office owner only for offices; room manager for shared rooms.
  fastify.patch(
    '/rooms/:id/door',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = doorBody.parse(request.body);

      const room = await fetchOrgRoom(user.org_id, id);
      if (!room) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Room not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const isAdmin = user.is_superuser || isOrgAdminOrOwner(user.role);
      let allowed = isAdmin;

      if (!allowed) {
        if (room.type === 'office') {
          // Office owner only
          allowed = room.owner_id === user.id;
        } else {
          // Shared room: any room manager
          const aclRole = await getAclRole(id, user.id);
          allowed = aclRole === 'manager';
        }
      }

      if (!allowed) {
        const message =
          room.type === 'office'
            ? 'Only the office owner can change its door'
            : 'Only a room manager can change this room\'s door';
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message,
            details: [],
            request_id: request.id,
          },
        });
      }

      // Persist the new default privacy. Live "door overrides" (e.g. DND
      // for a short window) are owned by workstream 3 in Redis; this
      // updates the durable fallback that renders when no override is set.
      const [updated] = await db
        .update(bureauRooms)
        .set({ privacy_default: body.privacy, updated_at: new Date() })
        .where(eq(bureauRooms.id, id))
        .returning();

      return reply.send({ data: updated });
    },
  );
}
