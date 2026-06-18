import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bookBookingPages, bookEvents, bookCalendars, users } from '../db/schema/index.js';
import { notFound, badRequest, conflict } from '../lib/utils.js';
import { eventUrl } from '../lib/urls.js';
import * as availabilityService from './availability.service.js';
import { buildBookHuddleRoomName } from './event.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateBookingPageInput {
  slug: string;
  title: string;
  description?: string;
  duration_minutes?: number;
  buffer_before_min?: number;
  buffer_after_min?: number;
  max_advance_days?: number;
  min_notice_hours?: number;
  color?: string;
  logo_url?: string;
  confirmation_message?: string;
  redirect_url?: string;
  auto_create_bond_contact?: boolean;
  auto_create_bam_task?: boolean;
  bam_project_id?: string;
}

export interface UpdateBookingPageInput extends Partial<CreateBookingPageInput> {
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// List booking pages
// ---------------------------------------------------------------------------

export async function listBookingPages(orgId: string, userId: string) {
  const rows = await db
    .select()
    .from(bookBookingPages)
    .where(
      and(
        eq(bookBookingPages.organization_id, orgId),
        eq(bookBookingPages.owner_user_id, userId),
      ),
    )
    .orderBy(desc(bookBookingPages.created_at));

  return { data: rows };
}

// ---------------------------------------------------------------------------
// Get booking page
// ---------------------------------------------------------------------------

export async function getBookingPage(id: string, orgId: string) {
  const [page] = await db
    .select()
    .from(bookBookingPages)
    .where(and(eq(bookBookingPages.id, id), eq(bookBookingPages.organization_id, orgId)))
    .limit(1);

  if (!page) throw notFound('Booking page not found');
  return page;
}

// ---------------------------------------------------------------------------
// Create booking page
// ---------------------------------------------------------------------------

export async function createBookingPage(
  input: CreateBookingPageInput,
  orgId: string,
  userId: string,
) {
  // Check slug uniqueness within org
  const [existing] = await db
    .select({ id: bookBookingPages.id })
    .from(bookBookingPages)
    .where(
      and(
        eq(bookBookingPages.organization_id, orgId),
        eq(bookBookingPages.slug, input.slug),
      ),
    )
    .limit(1);

  if (existing) throw conflict('Slug already in use');

  const [page] = await db
    .insert(bookBookingPages)
    .values({
      organization_id: orgId,
      owner_user_id: userId,
      slug: input.slug,
      title: input.title,
      description: input.description,
      duration_minutes: input.duration_minutes ?? 30,
      buffer_before_min: input.buffer_before_min ?? 0,
      buffer_after_min: input.buffer_after_min ?? 15,
      max_advance_days: input.max_advance_days ?? 60,
      min_notice_hours: input.min_notice_hours ?? 4,
      color: input.color,
      logo_url: input.logo_url,
      confirmation_message: input.confirmation_message,
      redirect_url: input.redirect_url,
      auto_create_bond_contact: input.auto_create_bond_contact ?? true,
      auto_create_bam_task: input.auto_create_bam_task ?? false,
      bam_project_id: input.bam_project_id,
    })
    .returning();

  return page!;
}

// ---------------------------------------------------------------------------
// Update booking page
// ---------------------------------------------------------------------------

export async function updateBookingPage(
  id: string,
  orgId: string,
  input: UpdateBookingPageInput,
) {
  await getBookingPage(id, orgId);

  const [updated] = await db
    .update(bookBookingPages)
    .set({ ...input, updated_at: new Date() })
    .where(and(eq(bookBookingPages.id, id), eq(bookBookingPages.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Booking page not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete booking page
// ---------------------------------------------------------------------------

export async function deleteBookingPage(id: string, orgId: string) {
  await getBookingPage(id, orgId);

  const [deleted] = await db
    .delete(bookBookingPages)
    .where(and(eq(bookBookingPages.id, id), eq(bookBookingPages.organization_id, orgId)))
    .returning({ id: bookBookingPages.id });

  if (!deleted) throw notFound('Booking page not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Public: Get booking page by slug
// ---------------------------------------------------------------------------

export async function getPublicBookingPage(slug: string) {
  const [page] = await db
    .select({
      id: bookBookingPages.id,
      title: bookBookingPages.title,
      description: bookBookingPages.description,
      duration_minutes: bookBookingPages.duration_minutes,
      color: bookBookingPages.color,
      logo_url: bookBookingPages.logo_url,
      owner_user_id: bookBookingPages.owner_user_id,
      organization_id: bookBookingPages.organization_id,
      buffer_before_min: bookBookingPages.buffer_before_min,
      buffer_after_min: bookBookingPages.buffer_after_min,
      max_advance_days: bookBookingPages.max_advance_days,
      min_notice_hours: bookBookingPages.min_notice_hours,
      auto_create_bond_contact: bookBookingPages.auto_create_bond_contact,
      auto_create_bam_task: bookBookingPages.auto_create_bam_task,
      bam_project_id: bookBookingPages.bam_project_id,
    })
    .from(bookBookingPages)
    .where(and(eq(bookBookingPages.slug, slug), eq(bookBookingPages.enabled, true)))
    .limit(1);

  if (!page) throw notFound('Booking page not found');

  // Get owner info
  const [owner] = await db
    .select({
      display_name: users.display_name,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(eq(users.id, page.owner_user_id))
    .limit(1);

  return { ...page, owner_name: owner?.display_name, owner_avatar: owner?.avatar_url };
}

// ---------------------------------------------------------------------------
// Public: Get available slots for booking page
// ---------------------------------------------------------------------------

export async function getPublicSlots(slug: string, startDate: string, endDate: string) {
  const page = await getPublicBookingPage(slug);

  const slots = await availabilityService.getAvailability(
    page.owner_user_id,
    startDate,
    endDate,
  );

  // Filter to slots that are long enough for the meeting duration + buffers
  const minDuration = (page.duration_minutes + page.buffer_before_min + page.buffer_after_min) * 60 * 1000;

  const availableSlots = slots.filter((s) => {
    const duration = new Date(s.end).getTime() - new Date(s.start).getTime();
    return duration >= minDuration;
  });

  // Split into meeting-sized chunks. Field names are `start_at`/`end_at` to
  // match the public MeetPage UI (apps/book/src/pages/meet.tsx) and the
  // POST /meet/:slug/book request body, which both key on `start_at`.
  const meetingSlots: Array<{ start_at: string; end_at: string }> = [];
  for (const slot of availableSlots) {
    let cursor = new Date(slot.start).getTime() + page.buffer_before_min * 60 * 1000;
    const slotEnd = new Date(slot.end).getTime() - page.buffer_after_min * 60 * 1000;
    const meetingMs = page.duration_minutes * 60 * 1000;

    while (cursor + meetingMs <= slotEnd) {
      meetingSlots.push({
        start_at: new Date(cursor).toISOString(),
        end_at: new Date(cursor + meetingMs).toISOString(),
      });
      cursor += 30 * 60 * 1000; // 30-minute increments
    }
  }

  return { data: meetingSlots };
}

// ---------------------------------------------------------------------------
// Public: Book a slot
// ---------------------------------------------------------------------------

export async function bookSlot(
  slug: string,
  startAt: string,
  name: string,
  email: string,
  notes?: string,
) {
  const page = await getPublicBookingPage(slug);
  const start = new Date(startAt);
  const end = new Date(start.getTime() + page.duration_minutes * 60 * 1000);

  // Find the owner's default calendar
  const [calendar] = await db
    .select()
    .from(bookCalendars)
    .where(
      and(
        eq(bookCalendars.owner_user_id, page.owner_user_id),
        eq(bookCalendars.is_default, true),
      ),
    )
    .limit(1);

  if (!calendar) throw badRequest('Owner has no default calendar');

  // Use a transaction with row-level locking to prevent double-booking
  const event = await db.transaction(async (tx) => {
    // Lock overlapping rows and check for conflicts.
    // An overlap exists when: existing.start_at < requested.end AND existing.end_at > requested.start
    const overlapping = await tx
      .select({ id: bookEvents.id })
      .from(bookEvents)
      .where(
        and(
          eq(bookEvents.calendar_id, calendar.id),
          eq(bookEvents.status, 'confirmed'),
          // Bind the bounds as ISO strings: the postgres driver cannot bind a
          // raw Date object as a parameter inside a sql`` comparison template
          // (it throws ERR_INVALID_ARG_TYPE). Casting to timestamptz keeps the
          // comparison correct.
          sql`${bookEvents.start_at} < ${end.toISOString()}::timestamptz`,
          sql`${bookEvents.end_at} > ${start.toISOString()}::timestamptz`,
        ),
      )
      .for('update')
      .limit(1);

    if (overlapping.length > 0) {
      throw conflict('This time slot is no longer available');
    }

    // Create the event inside the transaction. D-4: a confirmed public
    // booking gets the canonical huddle room + the event deep link as its
    // meeting URL, so the organizer's calendar row carries a working
    // "join" target the docked box honors.
    const eventId = randomUUID();
    const [created] = await tx
      .insert(bookEvents)
      .values({
        id: eventId,
        calendar_id: calendar.id,
        organization_id: page.organization_id,
        title: `${page.title} with ${name}`,
        description: notes ?? '',
        meeting_url: eventUrl(eventId),
        livekit_room_name: buildBookHuddleRoomName(eventId),
        start_at: start,
        end_at: end,
        timezone: 'UTC',
        status: 'confirmed',
        visibility: 'busy',
        booking_page_id: page.id,
        booked_by_name: name,
        booked_by_email: email,
        created_by: page.owner_user_id,
      })
      .returning();

    return created!;
  });

  return event;
}
