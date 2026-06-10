/**
 * Bureau room bookings (workstream 2 — Agent B).
 *
 *   GET    /v1/rooms/:id/bookings  — list reservations in a window
 *   POST   /v1/rooms/:id/bookings  — create a reservation
 *   PATCH  /v1/bookings/:id        — update title/window
 *   DELETE /v1/bookings/:id        — soft-cancel (sets cancelled_at)
 *
 * The cross-app Book event id is accepted as a freeform UUID at this
 * stage (the actual Book-side write happens in a follow-up workstream
 * once book-api exposes a `bureau`-scoped create-event call). If the
 * client omits it we mint a random UUID so the column constraint is
 * satisfied and downstream linkage can resolve the row later.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, isNull, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauBookings, bureauSettings } from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  forbidden,
  isOrgAdminOrOwner,
  loadRoom,
  notFound,
  roomNotFound,
} from '../middleware/room-access.js';

const isoDateTime = z.string().datetime({ offset: true });

const listQuery = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

const createBody = z.object({
  title: z.string().min(1).max(200),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  access: z.enum(['open', 'locked']).default('open'),
  book_event_id: z.string().uuid().optional(),
});

const patchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  starts_at: isoDateTime.optional(),
  ends_at: isoDateTime.optional(),
  access: z.enum(['open', 'locked']).optional(),
});

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export default async function bookingsRoutes(fastify: FastifyInstance) {
  // GET /v1/rooms/:id/bookings — list reservations in a window
  fastify.get(
    '/rooms/:id/bookings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: roomId } = request.params as { id: string };
      const user = request.user!;

      const parsedQuery = listQuery.safeParse(request.query);
      if (!parsedQuery.success) {
        return badRequest(
          request,
          reply,
          'Invalid query parameters',
          parsedQuery.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }

      const room = await loadRoom(roomId, user.org_id);
      if (!room) return roomNotFound(request, reply);

      const now = Date.now();
      const fromTs = parsedQuery.data.from
        ? new Date(parsedQuery.data.from)
        : new Date(now);
      const toTs = parsedQuery.data.to
        ? new Date(parsedQuery.data.to)
        : new Date(now + DEFAULT_WINDOW_MS);

      if (toTs.getTime() <= fromTs.getTime()) {
        return badRequest(request, reply, '`to` must be after `from`');
      }

      // Bookings overlap the window when starts_at < to AND ends_at > from.
      const rows = await db
        .select({
          id: bureauBookings.id,
          org_id: bureauBookings.org_id,
          room_id: bureauBookings.room_id,
          book_event_id: bureauBookings.book_event_id,
          organizer_id: bureauBookings.organizer_id,
          title: bureauBookings.title,
          starts_at: bureauBookings.starts_at,
          ends_at: bureauBookings.ends_at,
          access: bureauBookings.access,
          created_at: bureauBookings.created_at,
          cancelled_at: bureauBookings.cancelled_at,
        })
        .from(bureauBookings)
        .where(
          and(
            eq(bureauBookings.room_id, roomId),
            eq(bureauBookings.org_id, user.org_id),
            isNull(bureauBookings.cancelled_at),
            lte(bureauBookings.starts_at, toTs),
            gte(bureauBookings.ends_at, fromTs),
          ),
        )
        .orderBy(asc(bureauBookings.starts_at));

      return reply
        .status(200)
        .send({ data: { bookings: rows, window: { from: fromTs, to: toTs } } });
    },
  );

  // POST /v1/rooms/:id/bookings — create a reservation
  fastify.post(
    '/rooms/:id/bookings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: roomId } = request.params as { id: string };
      const user = request.user!;

      const parsed = createBody.safeParse(request.body);
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

      const room = await loadRoom(roomId, user.org_id);
      if (!room) return roomNotFound(request, reply);

      if (!room.capacity && room.type !== 'office') {
        // capacity may legitimately be null for many room types; we just
        // flag it for the gate below — do nothing here. Left as a no-op
        // for clarity.
      }

      const startsAt = new Date(parsed.data.starts_at);
      const endsAt = new Date(parsed.data.ends_at);
      if (endsAt.getTime() <= startsAt.getTime()) {
        return badRequest(request, reply, '`ends_at` must be after `starts_at`');
      }

      // Per-org policy gate: when members_can_book is false, only org
      // admins/owners (and SuperUsers) may create a booking. Settings
      // row may be absent for a brand-new org — default to "allowed"
      // to match the column default (true).
      const [settings] = await db
        .select({ members_can_book: bureauSettings.members_can_book })
        .from(bureauSettings)
        .where(eq(bureauSettings.org_id, user.org_id))
        .limit(1);
      const membersCanBook = settings?.members_can_book ?? true;
      if (!membersCanBook && !user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return forbidden(
          request,
          reply,
          'Member bookings are disabled for this organization',
        );
      }

      const bookEventId = parsed.data.book_event_id ?? crypto.randomUUID();

      const [created] = await db
        .insert(bureauBookings)
        .values({
          org_id: user.org_id,
          room_id: room.id,
          book_event_id: bookEventId,
          organizer_id: user.id,
          title: parsed.data.title,
          starts_at: startsAt,
          ends_at: endsAt,
          access: parsed.data.access,
        })
        .returning({
          id: bureauBookings.id,
          org_id: bureauBookings.org_id,
          room_id: bureauBookings.room_id,
          book_event_id: bureauBookings.book_event_id,
          organizer_id: bureauBookings.organizer_id,
          title: bureauBookings.title,
          starts_at: bureauBookings.starts_at,
          ends_at: bureauBookings.ends_at,
          access: bureauBookings.access,
          created_at: bureauBookings.created_at,
          cancelled_at: bureauBookings.cancelled_at,
        });

      return reply.status(201).send({ data: created });
    },
  );

  // PATCH /v1/bookings/:id — organizer or admin/owner
  fastify.patch(
    '/bookings/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: bookingId } = request.params as { id: string };
      const user = request.user!;

      const parsed = patchBody.safeParse(request.body);
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

      const [existing] = await db
        .select({
          id: bureauBookings.id,
          organizer_id: bureauBookings.organizer_id,
          starts_at: bureauBookings.starts_at,
          ends_at: bureauBookings.ends_at,
          cancelled_at: bureauBookings.cancelled_at,
        })
        .from(bureauBookings)
        .where(
          and(
            eq(bureauBookings.id, bookingId),
            eq(bureauBookings.org_id, user.org_id),
          ),
        )
        .limit(1);

      if (!existing) return notFound(request, reply, 'Booking not found');
      if (existing.cancelled_at) {
        return badRequest(request, reply, 'Cannot edit a cancelled booking');
      }

      const isOrganizer = existing.organizer_id === user.id;
      if (!isOrganizer && !user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return forbidden(
          request,
          reply,
          'Only the organizer or an org admin can update this booking',
        );
      }

      const nextStartsAt = parsed.data.starts_at
        ? new Date(parsed.data.starts_at)
        : existing.starts_at;
      const nextEndsAt = parsed.data.ends_at
        ? new Date(parsed.data.ends_at)
        : existing.ends_at;
      if (nextEndsAt.getTime() <= nextStartsAt.getTime()) {
        return badRequest(request, reply, '`ends_at` must be after `starts_at`');
      }

      const patch: Record<string, unknown> = {};
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.starts_at !== undefined) patch.starts_at = nextStartsAt;
      if (parsed.data.ends_at !== undefined) patch.ends_at = nextEndsAt;
      if (parsed.data.access !== undefined) patch.access = parsed.data.access;

      if (Object.keys(patch).length === 0) {
        return badRequest(request, reply, 'No updatable fields provided');
      }

      const [updated] = await db
        .update(bureauBookings)
        .set(patch)
        .where(
          and(
            eq(bureauBookings.id, bookingId),
            eq(bureauBookings.org_id, user.org_id),
          ),
        )
        .returning({
          id: bureauBookings.id,
          org_id: bureauBookings.org_id,
          room_id: bureauBookings.room_id,
          book_event_id: bureauBookings.book_event_id,
          organizer_id: bureauBookings.organizer_id,
          title: bureauBookings.title,
          starts_at: bureauBookings.starts_at,
          ends_at: bureauBookings.ends_at,
          access: bureauBookings.access,
          created_at: bureauBookings.created_at,
          cancelled_at: bureauBookings.cancelled_at,
        });

      return reply.status(200).send({ data: updated });
    },
  );

  // DELETE /v1/bookings/:id — soft cancel
  fastify.delete(
    '/bookings/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: bookingId } = request.params as { id: string };
      const user = request.user!;

      const [existing] = await db
        .select({
          id: bureauBookings.id,
          organizer_id: bureauBookings.organizer_id,
          cancelled_at: bureauBookings.cancelled_at,
        })
        .from(bureauBookings)
        .where(
          and(
            eq(bureauBookings.id, bookingId),
            eq(bureauBookings.org_id, user.org_id),
          ),
        )
        .limit(1);

      if (!existing) return notFound(request, reply, 'Booking not found');
      if (existing.cancelled_at) {
        return reply.status(200).send({ data: { id: bookingId, cancelled: true } });
      }

      const isOrganizer = existing.organizer_id === user.id;
      if (!isOrganizer && !user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return forbidden(
          request,
          reply,
          'Only the organizer or an org admin can cancel this booking',
        );
      }

      const [cancelled] = await db
        .update(bureauBookings)
        .set({ cancelled_at: new Date() })
        .where(
          and(
            eq(bureauBookings.id, bookingId),
            eq(bureauBookings.org_id, user.org_id),
          ),
        )
        .returning({
          id: bureauBookings.id,
          cancelled_at: bureauBookings.cancelled_at,
        });

      return reply.status(200).send({ data: cancelled });
    },
  );
}
