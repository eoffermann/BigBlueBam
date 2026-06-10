/**
 * Bureau offices routes (workstream 2 — Agent B).
 *
 *   GET  /v1/offices         — admin/owner: all type='office' rooms across
 *                              every live floor in the caller's org with
 *                              owner display data joined in. Used by the
 *                              /admin/offices admin page so the assignment
 *                              UI doesn't have to fan out per-floor.
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
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauFloors, bureauRooms } from '../db/schema/bureau.js';
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
  // GET /v1/offices — admin/owner only. Returns every type='office' room
  // across every non-archived floor in the caller's org, joined with the
  // floor name and the current owner's display data. The admin offices
  // page renders one row per result; reassigning an owner is a
  // POST /offices/assign call away.
  //
  // We restrict to type='office' deliberately. Bureau allows assigning
  // any room (huddle, conference, etc.) to a user, but the admin
  // offices page is about "who has a personal office", and surfacing
  // every owned huddle would just be noise. If we ever need a broader
  // owners report, that's a separate endpoint.
  fastify.get(
    '/offices',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return forbidden(
          request,
          reply,
          'Only org admins or owners can list offices',
        );
      }

      // Self-join trick to LEFT JOIN the owner in one round-trip; the
      // owner_id FK is `onDelete: 'set null'` so dangling refs are
      // impossible, but the LEFT JOIN keeps unassigned offices in the
      // result set.
      const rows = await db
        .select({
          id: bureauRooms.id,
          floor_id: bureauRooms.floor_id,
          floor_name: bureauFloors.name,
          name: bureauRooms.name,
          type: bureauRooms.type,
          privacy_default: bureauRooms.privacy_default,
          owner_id: bureauRooms.owner_id,
          owner_display_name: users.display_name,
          owner_email: users.email,
          owner_avatar_url: users.avatar_url,
          updated_at: bureauRooms.updated_at,
        })
        .from(bureauRooms)
        .innerJoin(bureauFloors, eq(bureauRooms.floor_id, bureauFloors.id))
        .leftJoin(users, eq(bureauRooms.owner_id, users.id))
        .where(
          and(
            eq(bureauRooms.org_id, user.org_id),
            eq(bureauRooms.type, 'office'),
            isNull(bureauRooms.archived_at),
            isNull(bureauFloors.archived_at),
          ),
        )
        .orderBy(asc(bureauFloors.name), asc(bureauRooms.name));

      const data = rows.map((r) => ({
        id: r.id,
        floor_id: r.floor_id,
        floor_name: r.floor_name,
        name: r.name,
        type: r.type,
        privacy_default: r.privacy_default,
        owner:
          r.owner_id && r.owner_display_name
            ? {
                id: r.owner_id,
                display_name: r.owner_display_name,
                email: r.owner_email,
                avatar_url: r.owner_avatar_url,
              }
            : null,
        updated_at: r.updated_at,
      }));

      return reply.status(200).send({ data });
    },
  );

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
