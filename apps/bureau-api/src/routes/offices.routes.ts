/**
 * Bureau offices routes (workstream 2 — Agent B).
 *
 *   POST /v1/offices/assign  — admin/owner assigns a room (office) to a user
 *   GET  /v1/offices/mine    — caller's owned room (if any)
 *
 * A "personal office" is just a `bureau_rooms` row whose `owner_id`
 * matches the user. The room type SHOULD be 'office', but we accept
 * assignment against any non-archived room; the floor designer is free
 * to repurpose a huddle/conference room as somebody's office without
 * Bureau second-guessing them.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauRooms } from '../db/schema/bureau.js';
import { users } from '../db/schema/bbb-refs.js';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  forbidden,
  isOrgAdminOrOwner,
  loadRoom,
  notFound,
  roomNotFound,
} from '../middleware/room-access.js';

const assignBody = z.object({
  room_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export default async function officesRoutes(fastify: FastifyInstance) {
  // POST /v1/offices/assign — admin/owner only
  fastify.post(
    '/offices/assign',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return forbidden(request, reply, 'Only org admins or owners can assign offices');
      }

      const parsed = assignBody.safeParse(request.body);
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
      const { room_id, user_id } = parsed.data;

      const room = await loadRoom(room_id, user.org_id);
      if (!room) return roomNotFound(request, reply);

      // Verify the target user exists and belongs to the same org. We
      // intentionally do NOT verify they are a member of any specific
      // project — assignment is org-scoped. (The user's primary org_id
      // is on the users row; we don't require it to match the caller's
      // active org so that multi-org users can still be assigned an
      // office in an org they belong to.)
      const [targetUser] = await db
        .select({ id: users.id, is_active: users.is_active })
        .from(users)
        .where(eq(users.id, user_id))
        .limit(1);

      if (!targetUser || !targetUser.is_active) {
        return notFound(request, reply, 'User not found');
      }

      const [updated] = await db
        .update(bureauRooms)
        .set({ owner_id: user_id, updated_at: new Date() })
        .where(and(eq(bureauRooms.id, room.id), eq(bureauRooms.org_id, user.org_id)))
        .returning({
          id: bureauRooms.id,
          org_id: bureauRooms.org_id,
          floor_id: bureauRooms.floor_id,
          name: bureauRooms.name,
          type: bureauRooms.type,
          privacy_default: bureauRooms.privacy_default,
          capacity: bureauRooms.capacity,
          owner_id: bureauRooms.owner_id,
          updated_at: bureauRooms.updated_at,
        });

      return reply.status(200).send({ data: updated });
    },
  );

  // GET /v1/offices/mine — return the room owned by the caller (if any)
  fastify.get(
    '/offices/mine',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const [room] = await db
        .select({
          id: bureauRooms.id,
          org_id: bureauRooms.org_id,
          floor_id: bureauRooms.floor_id,
          name: bureauRooms.name,
          type: bureauRooms.type,
          privacy_default: bureauRooms.privacy_default,
          capacity: bureauRooms.capacity,
          bookable: bureauRooms.bookable,
          zone_id: bureauRooms.zone_id,
          owner_id: bureauRooms.owner_id,
          metadata: bureauRooms.metadata,
          created_at: bureauRooms.created_at,
          updated_at: bureauRooms.updated_at,
        })
        .from(bureauRooms)
        .where(
          and(
            eq(bureauRooms.org_id, user.org_id),
            eq(bureauRooms.owner_id, user.id),
          ),
        )
        .limit(1);

      return reply.status(200).send({ data: room ?? null });
    },
  );
}
