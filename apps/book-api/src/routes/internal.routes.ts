/**
 * Internal cross-app routes for Book (workstream 4 — Agent A).
 *
 * These endpoints are NOT user-facing. They are called by other
 * BigBlueBam services (today: bureau-api when a member books a room
 * on the floorplan) over the internal network, and are authenticated
 * by the shared INTERNAL_SERVICE_SECRET header (`X-Internal-Service-Secret`).
 * Cookie / API key auth does NOT apply on this surface — the secret IS
 * the credential.
 *
 * Why this exists:
 *   A Bureau room reservation is also a calendar event from the team's
 *   point of view: it should show up in Book's timeline, be exportable
 *   over iCal, and be cancellable from either side. The user-facing
 *   POST /v1/rooms/:id/bookings in bureau-api calls into this route to
 *   create the authoritative Book event so the bureau_bookings row can
 *   anchor to a real book_event_id rather than a self-minted UUID.
 *
 *   When the bureau booking is cancelled (DELETE /v1/bookings/:id in
 *   bureau-api), the same flow flips the linked Book event's status
 *   to 'cancelled'. Calendar consistency without leaking auth surface.
 *
 * Scoping:
 *   - Each org gets exactly one bureau-owned book_calendar row, lazily
 *     provisioned on first use (organization_id + calendar_type='bureau').
 *     This is intentionally distinct from a user's personal calendar so
 *     the team can subscribe to "all bureau bookings" via iCal without
 *     pulling in everyone's 1:1s.
 *   - The organizer is added as a Book attendee with is_organizer=true.
 *     We do not (yet) pull the rest of the room's invitees — Book
 *     ownership of the attendee list is a v2 concern. For now the bureau
 *     row's organizer + access flag is the authority on who can join.
 *
 * meeting_url:
 *   Built as `${PUBLIC_URL}/bureau/room/{roomId}/join` so the calendar
 *   row carries a clickable "join now" link. PUBLIC_URL is already used
 *   by lib/urls.ts for the same reason; using it here keeps the URL
 *   shape coherent across the app.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { env } from '../env.js';
import {
  bookCalendars,
  bookEvents,
  bookEventAttendees,
  users,
} from '../db/schema/index.js';

// ─────────────────────────────────────────────────────────────────────
// Internal-secret guard.
//
// Mirrors apps/bureau-api/src/routes/internal.routes.ts so the posture
// is identical across services: timing-safe compare against
// env.INTERNAL_SERVICE_SECRET, 401 on mismatch, 503 if the secret is
// not configured (fail-closed — never accept the request).
// ─────────────────────────────────────────────────────────────────────

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Constant-time op against ourselves so length mismatch does not
    // leak via timing differences.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function getInternalSecretHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-internal-service-secret'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const expected = env.INTERNAL_SERVICE_SECRET;
  if (!expected) {
    await reply.status(503).send({
      error: {
        code: 'INTERNAL_AUTH_UNCONFIGURED',
        message:
          'Internal service secret is not configured on this Book API instance',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  const provided = getInternalSecretHeader(request);
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    await reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const createEventBody = z.object({
  org_id: z.string().uuid(),
  organizer_id: z.string().uuid(),
  room_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
});

const cancelParams = z.object({
  id: z.string().uuid(),
});

const getParams = z.object({
  id: z.string().uuid(),
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Lazily resolve (or create) the per-org bureau calendar. This is the
 * destination calendar for every Bureau-originated event so they cluster
 * together in iCal subscriptions and in the Book timeline filter.
 *
 * The unique constraint is logical, not enforced at the DB level — we
 * fall back to the first matching row if multiple exist (would only
 * happen under a race between two simultaneous first-booking requests,
 * which is acceptable: both rows are valid bureau calendars).
 */
async function resolveBureauCalendarId(
  orgId: string,
  ownerUserId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: bookCalendars.id })
    .from(bookCalendars)
    .where(
      and(
        eq(bookCalendars.organization_id, orgId),
        eq(bookCalendars.calendar_type, 'bureau'),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(bookCalendars)
    .values({
      organization_id: orgId,
      owner_user_id: ownerUserId,
      name: 'Bureau Bookings',
      description:
        'Auto-managed calendar for Bureau room reservations. Events created by Bureau land here.',
      color: '#7c3aed',
      calendar_type: 'bureau',
      is_default: false,
      timezone: 'UTC',
    })
    .returning({ id: bookCalendars.id });

  if (!created) {
    throw new Error('Failed to provision Bureau calendar');
  }
  return created.id;
}

function buildMeetingUrl(roomId: string): string {
  const base = env.PUBLIC_URL.replace(/\/$/, '');
  if (!base) {
    // Relative fallback — keeps the row meaningful in dev where
    // PUBLIC_URL was not set, even though most consumers will need an
    // absolute URL.
    return `/bureau/room/${roomId}/join`;
  }
  return `${base}/bureau/room/${roomId}/join`;
}

// ─────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────

export default async function internalRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/internal/events
   *
   * Bureau-driven event creation. Returns { book_event_id, meeting_url }.
   *
   * The created event:
   *   - lives on the per-org bureau calendar (lazily provisioned)
   *   - lists the bureau organizer as an attendee with is_organizer=true
   *   - carries a meeting_url pointing at the Bureau room join page
   *   - inherits status='confirmed' and visibility='busy'
   */
  fastify.post(
    '/internal/events',
    async (request, reply) => {
      if (!(await requireInternalSecret(request, reply))) return;

      const parsed = createEventBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { org_id, organizer_id, room_id, title, starts_at, ends_at } =
        parsed.data;

      const startsAt = new Date(starts_at);
      const endsAt = new Date(ends_at);
      if (endsAt.getTime() <= startsAt.getTime()) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: '`ends_at` must be after `starts_at`',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Resolve the organizer's email + display_name for the attendee
      // row. Bureau guarantees the user belongs to the org but we cap
      // the query with both predicates as a safety net.
      const [organizer] = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
        })
        .from(users)
        .where(and(eq(users.id, organizer_id), eq(users.org_id, org_id)))
        .limit(1);

      if (!organizer) {
        return reply.status(400).send({
          error: {
            code: 'ORGANIZER_NOT_FOUND',
            message: 'Organizer does not belong to the requested organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      const calendarId = await resolveBureauCalendarId(org_id, organizer.id);
      const meetingUrl = buildMeetingUrl(room_id);

      const [event] = await db
        .insert(bookEvents)
        .values({
          calendar_id: calendarId,
          organization_id: org_id,
          title,
          location: `Bureau room ${room_id}`,
          meeting_url: meetingUrl,
          // D-4: Bureau reservations join the spatial room, not a huddle.
          livekit_room_name: `bureau-room-${room_id}`,
          start_at: startsAt,
          end_at: endsAt,
          all_day: false,
          timezone: 'UTC',
          status: 'confirmed',
          visibility: 'busy',
          created_by: organizer.id,
        })
        .returning({ id: bookEvents.id });

      if (!event) {
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to create Book event',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Best-effort attendee insert. If it fails we still return the
      // event so Bureau is not stranded — the attendee can be backfilled
      // later. Errors are logged but do not surface.
      try {
        await db.insert(bookEventAttendees).values({
          event_id: event.id,
          user_id: organizer.id,
          email: organizer.email,
          name: organizer.display_name,
          is_organizer: true,
          response_status: 'accepted',
        });
      } catch (err) {
        request.log.warn(
          { err, eventId: event.id, organizerId: organizer.id },
          'internal/events: failed to insert organizer attendee row (continuing)',
        );
      }

      return reply.status(201).send({
        data: {
          book_event_id: event.id,
          meeting_url: meetingUrl,
        },
      });
    },
  );

  /**
   * POST /v1/internal/events/:id/cancel
   *
   * Bureau-driven cancellation. Flips the event status to 'cancelled'.
   * Idempotent: cancelling an already-cancelled event is a no-op success.
   * Returns 404 if the event does not exist.
   */
  fastify.post(
    '/internal/events/:id/cancel',
    async (request, reply) => {
      if (!(await requireInternalSecret(request, reply))) return;

      const parsed = cancelParams.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid event id',
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const [existing] = await db
        .select({ id: bookEvents.id, status: bookEvents.status })
        .from(bookEvents)
        .where(eq(bookEvents.id, parsed.data.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Event not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.status === 'cancelled') {
        return reply
          .status(200)
          .send({ data: { id: existing.id, status: 'cancelled' } });
      }

      const [updated] = await db
        .update(bookEvents)
        .set({ status: 'cancelled', updated_at: new Date() })
        .where(eq(bookEvents.id, existing.id))
        .returning({ id: bookEvents.id, status: bookEvents.status });

      return reply.status(200).send({ data: updated });
    },
  );

  /**
   * GET /v1/internal/events/:id
   *
   * Internal lookup used by Bureau (and any other peer service) that
   * wants to render Book metadata next to its own row. Returns the
   * canonical event fields; attendees are not included here because
   * the v1 consumer (Bureau) does not need them.
   */
  fastify.get(
    '/internal/events/:id',
    async (request, reply) => {
      if (!(await requireInternalSecret(request, reply))) return;

      const parsed = getParams.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid event id',
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const [event] = await db
        .select({
          id: bookEvents.id,
          title: bookEvents.title,
          status: bookEvents.status,
          start_at: bookEvents.start_at,
          end_at: bookEvents.end_at,
          meeting_url: bookEvents.meeting_url,
          organization_id: bookEvents.organization_id,
          calendar_id: bookEvents.calendar_id,
        })
        .from(bookEvents)
        .where(eq(bookEvents.id, parsed.data.id))
        .limit(1);

      if (!event) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Event not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.status(200).send({ data: event });
    },
  );
}
