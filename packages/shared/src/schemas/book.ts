import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BookCalendarType = z.enum(['personal', 'team', 'project', 'booking']);
export const BookEventStatus = z.enum(['tentative', 'confirmed', 'cancelled']);
export const BookEventVisibility = z.enum(['free', 'busy', 'tentative', 'out_of_office']);
export const BookRecurrenceRule = z.enum(['daily', 'weekly', 'biweekly', 'monthly']);
export const BookLinkedEntityType = z.enum([
  'bam_task',
  'bond_deal',
  'helpdesk_ticket',
]);
export const BookRsvpResponse = z.enum(['accepted', 'declined', 'tentative']);
export const BookSyncDirection = z.enum(['inbound', 'outbound', 'both']);

// ── Calendar schemas ───────────────────────────────────────────────────
export const createBookCalendarSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  calendar_type: BookCalendarType.optional(),
  timezone: z.string().max(50).optional(),
  project_id: z.string().uuid().optional(),
});

export const updateBookCalendarSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(50).optional(),
});

export const listBookCalendarsQuerySchema = z.object({
  calendar_type: z.string().optional(),
});

// ── Event schemas ──────────────────────────────────────────────────────
export const createBookEventSchema = z.object({
  calendar_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  meeting_url: z.string().url().optional(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  all_day: z.boolean().optional(),
  timezone: z.string().max(50).optional(),
  recurrence_rule: BookRecurrenceRule.optional(),
  recurrence_end_at: z.string().datetime().optional(),
  status: BookEventStatus.optional(),
  visibility: BookEventVisibility.optional(),
  linked_entity_type: BookLinkedEntityType.optional(),
  linked_entity_id: z.string().uuid().optional(),
});

export const updateBookEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  meeting_url: z.string().url().nullable().optional(),
  start_at: z.string().datetime().optional(),
  end_at: z.string().datetime().optional(),
  all_day: z.boolean().optional(),
  timezone: z.string().max(50).optional(),
  status: BookEventStatus.optional(),
  visibility: BookEventVisibility.optional(),
});

export const rsvpBookEventSchema = z.object({
  response_status: BookRsvpResponse,
});

export const listBookEventsQuerySchema = z.object({
  calendar_ids: z.string().optional(), // comma-separated UUIDs
  start_after: z.string().datetime().optional(),
  start_before: z.string().datetime().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().optional(),
  sort: z.string().optional(),
});

// ── Availability schemas ───────────────────────────────────────────────
export const bookAvailabilityQuerySchema = z.object({
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
});

export const bookTeamAvailabilityQuerySchema = z.object({
  user_ids: z.string(), // comma-separated UUIDs
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
});

export const bookWorkingHoursSchema = z.array(
  z.object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    timezone: z.string().max(50).optional(),
    enabled: z.boolean().optional(),
  }),
);

// ── Booking page schemas ───────────────────────────────────────────────
export const createBookBookingPageSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  buffer_before_min: z.number().int().min(0).max(60).optional(),
  buffer_after_min: z.number().int().min(0).max(60).optional(),
  max_advance_days: z.number().int().min(1).max(365).optional(),
  min_notice_hours: z.number().int().min(0).max(168).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo_url: z.string().url().optional(),
  confirmation_message: z.string().max(2000).optional(),
  redirect_url: z.string().url().optional(),
  auto_create_bond_contact: z.boolean().optional(),
  auto_create_bam_task: z.boolean().optional(),
  bam_project_id: z.string().uuid().optional(),
});

export const updateBookBookingPageSchema = createBookBookingPageSchema.partial();

export const listBookBookingPagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Public booking schemas ─────────────────────────────────────────────
export const bookPublicSlotsQuerySchema = z.object({
  start_date: z.string(),
  end_date: z.string(),
});

export const bookPublicBookSchema = z.object({
  start_at: z.string().datetime(),
  name: z.string().min(1).max(200),
  email: z.string().email().max(255),
  notes: z.string().max(2000).optional(),
});

// ── Timeline schemas ───────────────────────────────────────────────────
export const bookTimelineQuerySchema = z.object({
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
});

// ── Connection schemas ─────────────────────────────────────────────────
export const connectBookGoogleSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  external_calendar_id: z.string(),
  sync_direction: BookSyncDirection.optional(),
});

export const connectBookMicrosoftSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  external_calendar_id: z.string(),
  sync_direction: BookSyncDirection.optional(),
});
