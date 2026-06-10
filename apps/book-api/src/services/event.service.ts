import { randomUUID } from 'node:crypto';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bookEvents, bookEventAttendees } from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { eventUrl } from '../lib/urls.js';

/**
 * Canonical LiveKit room for a Book-native event (D-4). Matches the v2
 * unified-call naming contract: the Bureau docked box auto-joins this room
 * for anyone viewing /book/events/{id} because the Book SPA advertises the
 * event id as its surface_id.
 */
export function buildBookHuddleRoomName(eventId: string): string {
  return `huddle-book-${eventId}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventFilters {
  organization_id: string;
  calendar_ids?: string[];
  start_after?: string;
  start_before?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface CreateEventInput {
  calendar_id: string;
  title: string;
  description?: string;
  location?: string;
  meeting_url?: string;
  start_at: string;
  end_at: string;
  all_day?: boolean;
  timezone?: string;
  recurrence_rule?: string;
  recurrence_end_at?: string;
  status?: string;
  visibility?: string;
  linked_entity_type?: string;
  linked_entity_id?: string;
  attendees?: Array<{
    user_id?: string;
    email: string;
    name?: string;
    is_organizer?: boolean;
  }>;
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  location?: string;
  meeting_url?: string | null;
  start_at?: string;
  end_at?: string;
  all_day?: boolean;
  timezone?: string;
  status?: string;
  visibility?: string;
}

// ---------------------------------------------------------------------------
// List events
// ---------------------------------------------------------------------------

export async function listEvents(filters: EventFilters) {
  const conditions = [eq(bookEvents.organization_id, filters.organization_id)];

  if (filters.calendar_ids && filters.calendar_ids.length > 0) {
    conditions.push(inArray(bookEvents.calendar_id, filters.calendar_ids));
  }

  if (filters.start_after) {
    conditions.push(gte(bookEvents.end_at, new Date(filters.start_after)));
  }

  if (filters.start_before) {
    conditions.push(lte(bookEvents.start_at, new Date(filters.start_before)));
  }

  if (filters.status) {
    conditions.push(eq(bookEvents.status, filters.status));
  }

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(bookEvents)
      .where(and(...conditions))
      .orderBy(bookEvents.start_at)
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(bookEvents)
      .where(and(...conditions)),
  ]);

  return {
    data: rows,
    total: countResult[0]?.count ?? 0,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Get event with attendees
// ---------------------------------------------------------------------------

export async function getEvent(id: string, orgId: string) {
  const [event] = await db
    .select()
    .from(bookEvents)
    .where(and(eq(bookEvents.id, id), eq(bookEvents.organization_id, orgId)))
    .limit(1);

  if (!event) throw notFound('Event not found');

  const attendees = await db
    .select()
    .from(bookEventAttendees)
    .where(eq(bookEventAttendees.event_id, id));

  return { ...event, attendees };
}

// ---------------------------------------------------------------------------
// Create event
// ---------------------------------------------------------------------------

export async function createEvent(
  input: CreateEventInput,
  orgId: string,
  userId: string,
) {
  const startAt = new Date(input.start_at);
  const endAt = new Date(input.end_at);

  if (endAt <= startAt) {
    throw badRequest('End time must be after start time');
  }

  // D-4: every Book-native event without an explicit external meeting URL
  // gets the canonical huddle room + a deep link to the event page as its
  // join URL. Pre-generate the id so the URL/room land in the same insert.
  const eventId = randomUUID();
  const hasExternalMeetingUrl = !!input.meeting_url;

  const [event] = await db
    .insert(bookEvents)
    .values({
      id: eventId,
      calendar_id: input.calendar_id,
      organization_id: orgId,
      title: input.title,
      description: input.description,
      location: input.location,
      meeting_url: hasExternalMeetingUrl ? input.meeting_url : eventUrl(eventId),
      livekit_room_name: hasExternalMeetingUrl
        ? null
        : buildBookHuddleRoomName(eventId),
      start_at: startAt,
      end_at: endAt,
      all_day: input.all_day ?? false,
      timezone: input.timezone ?? 'UTC',
      recurrence_rule: input.recurrence_rule,
      recurrence_end_at: input.recurrence_end_at ? new Date(input.recurrence_end_at) : undefined,
      status: input.status ?? 'confirmed',
      visibility: input.visibility ?? 'busy',
      linked_entity_type: input.linked_entity_type,
      linked_entity_id: input.linked_entity_id,
      created_by: userId,
    })
    .returning();

  // Add attendees
  if (input.attendees && input.attendees.length > 0) {
    await db.insert(bookEventAttendees).values(
      input.attendees.map((a) => ({
        event_id: event!.id,
        user_id: a.user_id,
        email: a.email,
        name: a.name,
        is_organizer: a.is_organizer ?? false,
      })),
    );
  }

  return event!;
}

// ---------------------------------------------------------------------------
// Update event
// ---------------------------------------------------------------------------

export async function updateEvent(
  id: string,
  orgId: string,
  input: UpdateEventInput,
) {
  await getEvent(id, orgId);

  const updates: Record<string, unknown> = { ...input, updated_at: new Date() };
  if (input.start_at) updates.start_at = new Date(input.start_at);
  if (input.end_at) updates.end_at = new Date(input.end_at);

  const [updated] = await db
    .update(bookEvents)
    .set(updates)
    .where(and(eq(bookEvents.id, id), eq(bookEvents.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Event not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete/cancel event
// ---------------------------------------------------------------------------

export async function deleteEvent(id: string, orgId: string) {
  await getEvent(id, orgId);

  // Soft-cancel rather than hard-delete
  const [updated] = await db
    .update(bookEvents)
    .set({ status: 'cancelled', updated_at: new Date() })
    .where(and(eq(bookEvents.id, id), eq(bookEvents.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Event not found');
  return updated;
}

// ---------------------------------------------------------------------------
// RSVP
// ---------------------------------------------------------------------------

export async function rsvpEvent(
  eventId: string,
  orgId: string,
  userId: string,
  responseStatus: string,
) {
  // Verify event exists
  await getEvent(eventId, orgId);

  const [attendee] = await db
    .select()
    .from(bookEventAttendees)
    .where(
      and(
        eq(bookEventAttendees.event_id, eventId),
        eq(bookEventAttendees.user_id, userId),
      ),
    )
    .limit(1);

  if (!attendee) throw notFound('You are not an attendee of this event');

  const [updated] = await db
    .update(bookEventAttendees)
    .set({ response_status: responseStatus, updated_at: new Date() })
    .where(eq(bookEventAttendees.id, attendee.id))
    .returning();

  return updated!;
}
