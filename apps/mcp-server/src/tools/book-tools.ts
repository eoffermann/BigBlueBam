import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

function createBookClient(bookApiUrl: string, api: ApiClient) {
  const baseUrl = bookApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
}

type BookClient = ReturnType<typeof createBookClient>;

/**
 * Resolve a Book calendar identifier that may be either a UUID or a calendar
 * name. We list the caller's calendars (already org/visibility-scoped by the
 * Book API) and pick the first case-insensitive exact name match. Returns
 * `null` on miss so callers can surface a clean "Calendar not found" error.
 */
async function resolveCalendarId(
  book: BookClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await book.request('GET', '/calendars');
  if (!result.ok) return null;
  const calendars =
    (result.data as { data?: Array<{ id: string; name: string }> } | null)?.data ?? [];
  const target = nameOrId.toLowerCase();
  const match = calendars.find((c) => c.name.toLowerCase() === target);
  return match?.id ?? null;
}

/**
 * Resolve a Book event identifier that may be either a UUID or an event
 * title. The Book API has no title-search endpoint, so we list events via
 * `GET /events` (optionally scoped to a calendar) and pick a unique exact or
 * single fuzzy match. Requires the caller to provide a window (or we widen
 * to a generous +/- 1 year default) so the list stays bounded.
 *
 * Returns `null` when no match, more than one exact match, or the list call
 * fails. Callers should surface a clean "Event not found" error.
 */
async function resolveEventId(
  book: BookClient,
  nameOrId: string,
  calendarId?: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  // Bound the search window so listEvents stays cheap. One year on either
  // side of "now" is more than enough for resolving an event by title.
  const now = Date.now();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const params = new URLSearchParams({
    start_after: new Date(now - oneYear).toISOString(),
    start_before: new Date(now + oneYear).toISOString(),
    limit: '500',
  });
  if (calendarId) params.set('calendar_ids', calendarId);
  const result = await book.request('GET', `/events?${params.toString()}`);
  if (!result.ok) return null;
  const events =
    (result.data as { data?: Array<{ id: string; title: string }> } | null)?.data ?? [];
  const target = nameOrId.toLowerCase();
  const exact = events.filter((e) => e.title.toLowerCase() === target);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;
  const fuzzy = events.filter((e) => e.title.toLowerCase().includes(target));
  if (fuzzy.length === 1) return fuzzy[0]!.id;
  return null;
}

/**
 * Resolve a user identifier to a UUID. Accepts a UUID (short-circuit) or an
 * email address via the shared Bam `/users/by-email` endpoint which is
 * org-scoped to the caller. Returns `null` when the input looks like neither,
 * or when the email does not resolve to a user.
 */
async function resolveUserIdByEmail(
  api: ApiClient,
  idOrEmail: string,
): Promise<string | null> {
  if (isUuid(idOrEmail)) return idOrEmail;
  if (!idOrEmail.includes('@')) return null;
  const result = await api.get(`/users/by-email?email=${encodeURIComponent(idOrEmail)}`);
  if (!result.ok) return null;
  const envelope = result.data as { data?: { id?: string } | null } | null;
  return envelope?.data?.id ?? null;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const eventShape = z.object({
  id: z.string().uuid(),
  title: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  calendar_id: z.string().uuid().optional(),
  status: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const slotShape = z.object({ start: z.string(), end: z.string() });

export function registerBookTools(server: McpServer, api: ApiClient, bookApiUrl: string): void {
  const client = createBookClient(bookApiUrl, api);

  // ===== 1. book_list_events =====
  registerTool(server, {
    name: 'book_list_events',
    description: 'List calendar events in a date range, optionally filtered by calendar IDs.',
    input: {
      start_after: z.string().describe('ISO 8601 date — events ending after this time'),
      start_before: z.string().describe('ISO 8601 date — events starting before this time'),
      calendar_ids: z.string().optional().describe('Comma-separated calendar UUIDs'),
      limit: z.number().int().positive().max(500).optional().describe('Page size (default 100)'),
    },
    returns: z.object({ data: z.array(eventShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/events${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing events', result.data);
    },
  });

  // ===== 2. book_create_event =====
  registerTool(server, {
    name: 'book_create_event',
    description: 'Create a calendar event with optional attendees. `calendar_id` accepts either a UUID or a calendar name (case-insensitive). Each attendee `user_id` accepts either a UUID or an email address.',
    input: {
      calendar_id: z.string().describe('Calendar UUID or name to create the event in'),
      title: z.string().min(1).max(500).describe('Event title'),
      start_at: z.string().describe('ISO 8601 start time'),
      end_at: z.string().describe('ISO 8601 end time'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Physical location or address'),
      meeting_url: z.string().optional().describe('Virtual meeting URL'),
      all_day: z.boolean().optional().describe('Is this an all-day event?'),
      attendees: z.array(z.object({
        email: z.string().email(),
        name: z.string().optional(),
        user_id: z.string().optional().describe('User UUID or email (falls back to the attendee email)'),
      })).optional().describe('List of attendees'),
    },
    returns: eventShape,
    handler: async (params) => {
      const resolvedCalendarId = await resolveCalendarId(client, params.calendar_id);
      if (!resolvedCalendarId) {
        return err('creating event', {
          error: `Calendar not found: ${params.calendar_id}`,
        });
      }

      // Resolve each attendee.user_id (UUID or email) in parallel. Attendees
      // that pass an email-only user_id are looked up via the Bam user store;
      // if resolution fails we drop the user_id rather than fail the whole
      // create — the calendar invite still works via the email field alone.
      let resolvedAttendees: typeof params.attendees = params.attendees;
      if (params.attendees && params.attendees.length > 0) {
        resolvedAttendees = await Promise.all(
          params.attendees.map(async (attendee) => {
            if (!attendee.user_id) return attendee;
            const resolved = await resolveUserIdByEmail(api, attendee.user_id);
            return resolved
              ? { ...attendee, user_id: resolved }
              : { ...attendee, user_id: undefined };
          }),
        );
      }

      const body = {
        ...params,
        calendar_id: resolvedCalendarId,
        attendees: resolvedAttendees,
      };
      const result = await client.request('POST', '/events', body);
      return result.ok ? ok(result.data) : err('creating event', result.data);
    },
  });

  // ===== 3. book_update_event =====
  registerTool(server, {
    name: 'book_update_event',
    description: 'Update an existing calendar event. `id` accepts either a UUID or an event title (case-insensitive exact or single fuzzy match within +/- 1 year of now).',
    input: {
      id: z.string().describe('Event UUID or title'),
      title: z.string().optional().describe('New title'),
      start_at: z.string().optional().describe('New start time'),
      end_at: z.string().optional().describe('New end time'),
      description: z.string().optional().describe('New description'),
      location: z.string().optional().describe('New location'),
      status: z.enum(['tentative', 'confirmed', 'cancelled']).optional(),
    },
    returns: eventShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveEventId(client, id);
      if (!resolvedId) {
        return err('updating event', {
          error: `Event not found (no unique match for): ${id}`,
        });
      }
      const result = await client.request('PATCH', `/events/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating event', result.data);
    },
  });

  // ===== 4. book_cancel_event =====
  registerTool(server, {
    name: 'book_cancel_event',
    description: 'Cancel a calendar event (sets status to cancelled). `id` accepts either a UUID or an event title.',
    input: {
      id: z.string().describe('Event UUID or title to cancel'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveEventId(client, id);
      if (!resolvedId) {
        return err('cancelling event', {
          error: `Event not found (no unique match for): ${id}`,
        });
      }
      const result = await client.request('DELETE', `/events/${resolvedId}`);
      return result.ok ? ok(result.data) : err('cancelling event', result.data);
    },
  });

  // ===== 5. book_get_availability =====
  registerTool(server, {
    name: 'book_get_availability',
    description: 'Get available time slots for a user in a date range. `user_id` accepts either a UUID or an email address.',
    input: {
      user_id: z.string().describe('User UUID or email to check availability for'),
      start_date: z.string().describe('ISO 8601 range start'),
      end_date: z.string().describe('ISO 8601 range end'),
    },
    returns: z.object({ user_id: z.string().uuid(), slots: z.array(slotShape) }).passthrough(),
    handler: async ({ user_id, ...params }) => {
      const resolvedUserId = await resolveUserIdByEmail(api, user_id);
      if (!resolvedUserId) {
        return err('getting availability', {
          error: `User not found: ${user_id}`,
        });
      }
      const result = await client.request('GET', `/availability/${resolvedUserId}${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting availability', result.data);
    },
  });

  // ===== 6. book_get_team_availability =====
  registerTool(server, {
    name: 'book_get_team_availability',
    description: 'Get available time slots for multiple users to find common free times. Each entry in `user_ids` accepts either a UUID or an email address. Fails cleanly if any input cannot be resolved.',
    input: {
      user_ids: z.array(z.string()).min(2).describe('Array of user UUIDs or emails'),
      start_date: z.string().describe('ISO 8601 range start'),
      end_date: z.string().describe('ISO 8601 range end'),
    },
    returns: z.object({ data: z.record(z.array(slotShape)) }).passthrough(),
    handler: async ({ user_ids, ...params }) => {
      const resolved = await Promise.all(
        user_ids.map(async (u) => ({ input: u, id: await resolveUserIdByEmail(api, u) })),
      );
      const unresolved = resolved.filter((r) => !r.id).map((r) => r.input);
      if (unresolved.length > 0) {
        return err('getting team availability', {
          error: `Unresolved user(s): ${unresolved.join(', ')}`,
        });
      }
      const ids = resolved.map((r) => r.id!);
      const result = await client.request('GET', `/availability/team${buildQs({ user_ids: ids.join(','), ...params })}`);
      return result.ok ? ok(result.data) : err('getting team availability', result.data);
    },
  });

  // ===== 7. book_find_meeting_time =====
  registerTool(server, {
    name: 'book_find_meeting_time',
    description: 'AI-assisted: find optimal meeting times for a set of attendees. Returns up to 3 suggested slots. Each entry in `user_ids` accepts either a UUID or an email address.',
    input: {
      user_ids: z.array(z.string()).min(2).describe('Attendee user UUIDs or emails'),
      duration_minutes: z.number().int().min(5).max(480).describe('Meeting duration in minutes'),
      start_date: z.string().describe('Earliest date to consider'),
      end_date: z.string().describe('Latest date to consider'),
    },
    returns: z.object({ suggestions: z.array(slotShape) }),
    handler: async ({ user_ids, duration_minutes, start_date, end_date }) => {
      const resolved = await Promise.all(
        user_ids.map(async (u) => ({ input: u, id: await resolveUserIdByEmail(api, u) })),
      );
      const unresolved = resolved.filter((r) => !r.id).map((r) => r.input);
      if (unresolved.length > 0) {
        return err('finding meeting time', {
          error: `Unresolved user(s): ${unresolved.join(', ')}`,
        });
      }
      const ids = resolved.map((r) => r.id!);
      // Get team availability and find common slots
      const result = await client.request('GET', `/availability/team${buildQs({ user_ids: ids.join(','), start_date, end_date })}`);
      if (!result.ok) return err('getting team availability', result.data);

      const allSlots: Record<string, Array<{ start: string; end: string }>> = (result.data as { data: Record<string, Array<{ start: string; end: string }>> }).data;
      const durationMs = duration_minutes * 60 * 1000;

      // Find intersecting free slots
      const userIdList = Object.keys(allSlots);
      if (userIdList.length === 0) return ok({ suggestions: [] });

      let commonSlots = allSlots[userIdList[0]!]!;

      for (let i = 1; i < userIdList.length; i++) {
        const userSlots = allSlots[userIdList[i]!]!;
        commonSlots = intersectSlots(commonSlots, userSlots);
      }

      // Filter to slots long enough for the meeting
      const candidates = commonSlots
        .filter((s) => new Date(s.end).getTime() - new Date(s.start).getTime() >= durationMs)
        .slice(0, 3)
        .map((s) => ({
          start: s.start,
          end: new Date(new Date(s.start).getTime() + durationMs).toISOString(),
        }));

      return ok({ suggestions: candidates });
    },
  });

  // ===== 8. book_create_booking_page =====
  registerTool(server, {
    name: 'book_create_booking_page',
    description: 'Create a public booking page (scheduling link).',
    input: {
      slug: z.string().describe('URL slug for /meet/:slug'),
      title: z.string().describe('Page title shown to visitors'),
      description: z.string().optional().describe('Description'),
      duration_minutes: z.number().int().optional().describe('Meeting duration (default 30)'),
    },
    returns: z.object({ id: z.string().uuid(), slug: z.string(), url: z.string().optional() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/booking-pages', params);
      return result.ok ? ok(result.data) : err('creating booking page', result.data);
    },
  });

  // ===== 9. book_get_timeline =====
  registerTool(server, {
    name: 'book_get_timeline',
    description: 'Get aggregated cross-product timeline with Book events, Bam tasks, sprints, and more.',
    input: {
      start_date: z.string().describe('ISO 8601 range start'),
      end_date: z.string().describe('ISO 8601 range end'),
    },
    returns: z.object({ data: z.array(z.object({ type: z.string(), id: z.string(), title: z.string(), start_at: z.string() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/timeline${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting timeline', result.data);
    },
  });

  // ===== 10. book_rsvp_event =====
  registerTool(server, {
    name: 'book_rsvp_event',
    description: 'Accept, decline, or mark tentative for a calendar event on behalf of the current user. `event_id` accepts either a UUID or an event title.',
    input: {
      event_id: z.string().describe('Event UUID or title'),
      response_status: z.enum(['accepted', 'declined', 'tentative']).describe('RSVP response'),
    },
    returns: z.object({ event_id: z.string().uuid(), response_status: z.string(), updated_at: z.string().optional() }).passthrough(),
    handler: async ({ event_id, response_status }) => {
      const resolvedId = await resolveEventId(client, event_id);
      if (!resolvedId) {
        return err('RSVPing to event', {
          error: `Event not found (no unique match for): ${event_id}`,
        });
      }
      const result = await client.request('POST', `/events/${resolvedId}/rsvp`, { response_status });
      return result.ok ? ok(result.data) : err('RSVPing to event', result.data);
    },
  });

  // ===== §18 + §19 Wave 5 misc =====
  // book_find_meeting_time_for_users: finds meeting slots across a roster of
  // humans and agents. Agents and service-account users have no calendars;
  // they are treated as unconditionally available when
  // respect_working_hours_for_humans_only=true (default). Each entry in
  // user_ids accepts either a UUID or an email address.
  registerTool(server, {
    name: 'book_find_meeting_time_for_users',
    description:
      'Find meeting-time slots across a mixed roster of humans and agents/service accounts. Agents/service accounts have no calendars; when respect_working_hours_for_humans_only is true (default) they are treated as unconditionally available and skipped from conflict detection. Each entry in user_ids accepts a UUID or an email address. Returns slots with per-attendee availability annotations so the caller can render "agent: always available" alongside the human conflict picture.',
    input: {
      user_ids: z.array(z.string()).min(1).describe('Attendee user UUIDs or emails'),
      duration_minutes: z.number().int().min(5).max(480).describe('Meeting duration in minutes'),
      window: z.object({
        since: z.string().describe('ISO 8601 window start'),
        until: z.string().describe('ISO 8601 window end'),
      }).describe('Search window'),
      respect_working_hours_for_humans_only: z
        .boolean()
        .optional()
        .describe('Default true. When true, agents/service accounts are unconditionally available; when false, every user is treated as a human for scheduling purposes.'),
      timezone: z.string().optional().describe('IANA timezone for the caller, used only for rendering hints downstream.'),
    },
    returns: z.object({
      slots: z.array(
        z.object({
          start: z.string(),
          end: z.string(),
          attendees: z.array(
            z.object({
              user_id: z.string().uuid(),
              kind: z.enum(['human', 'agent', 'service']),
              available: z.boolean(),
            }),
          ),
        }),
      ),
    }),
    handler: async ({ user_ids, duration_minutes, window, respect_working_hours_for_humans_only, timezone }) => {
      const resolved = await Promise.all(
        user_ids.map(async (u) => ({ input: u, id: await resolveUserIdByEmail(api, u) })),
      );
      const unresolved = resolved.filter((r) => !r.id).map((r) => r.input);
      if (unresolved.length > 0) {
        return err('finding meeting time for users', {
          error: `Unresolved user(s): ${unresolved.join(', ')}`,
        });
      }
      const ids = resolved.map((r) => r.id!);
      const result = await client.request('POST', '/availability/meeting-time-mixed', {
        user_ids: ids,
        duration_minutes,
        window,
        respect_working_hours_for_humans_only,
        timezone,
      });
      return result.ok ? ok(result.data) : err('finding meeting time for users', result.data);
    },
  });

  // ===== 11. book_get_event =====
  registerTool(server, {
    name: 'book_get_event',
    description: 'Get a single calendar event by ID, including attendees and linked-entity context.',
    input: {
      id: z.string().uuid().describe('Event UUID'),
    },
    returns: eventShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/events/${id}`);
      return result.ok ? ok(result.data) : err('getting event', result.data);
    },
  });

  // ===== 12. book_list_calendars =====
  registerTool(server, {
    name: 'book_list_calendars',
    description: "List the caller's calendars, optionally filtered by calendar type (personal, team, project, booking).",
    input: {
      calendar_type: z.enum(['personal', 'team', 'project', 'booking']).optional().describe('Filter by calendar type'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), name: z.string(), calendar_type: z.string().optional() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/calendars${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing calendars', result.data);
    },
  });

  // ===== 13. book_create_calendar =====
  registerTool(server, {
    name: 'book_create_calendar',
    description: 'Create a calendar in the caller\'s organization.',
    input: {
      name: z.string().min(1).max(255).describe('Calendar name'),
      description: z.string().max(2000).optional().describe('Calendar description'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex color (e.g. "#3b82f6")'),
      calendar_type: z.enum(['personal', 'team', 'project', 'booking']).optional().describe('Calendar type (default personal)'),
      timezone: z.string().max(50).optional().describe('IANA timezone'),
      project_id: z.string().uuid().optional().describe('Project to scope the calendar to (when type is project)'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), name: z.string() }).passthrough() }),
    handler: async (params) => {
      const result = await client.request('POST', '/calendars', params);
      return result.ok ? ok(result.data) : err('creating calendar', result.data);
    },
  });

  // ===== 14. book_update_calendar =====
  registerTool(server, {
    name: 'book_update_calendar',
    description: 'Update a calendar\'s metadata. `id` accepts either a UUID or a calendar name (case-insensitive exact match). Provide only the fields to change.',
    input: {
      id: z.string().describe('Calendar UUID or name'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Updated hex color'),
      timezone: z.string().max(50).optional().describe('Updated IANA timezone'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), name: z.string() }).passthrough() }),
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveCalendarId(client, id);
      if (!resolvedId) {
        return err('updating calendar', { error: `Calendar not found: ${id}` });
      }
      const result = await client.request('PATCH', `/calendars/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating calendar', result.data);
    },
  });

  // ===== 15. book_delete_calendar =====
  registerTool(server, {
    name: 'book_delete_calendar',
    description: 'Delete a calendar. `id` accepts either a UUID or a calendar name (case-insensitive exact match).',
    input: {
      id: z.string().describe('Calendar UUID or name'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveCalendarId(client, id);
      if (!resolvedId) {
        return err('deleting calendar', { error: `Calendar not found: ${id}` });
      }
      const result = await client.request('DELETE', `/calendars/${resolvedId}`);
      return result.ok ? ok(result.data) : err('deleting calendar', result.data);
    },
  });

  // ===== 16. book_list_booking_pages =====
  registerTool(server, {
    name: 'book_list_booking_pages',
    description: "List the caller's public booking pages (scheduling links).",
    input: {},
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), slug: z.string(), title: z.string() }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/booking-pages');
      return result.ok ? ok(result.data) : err('listing booking pages', result.data);
    },
  });

  // ===== 17. book_update_booking_page =====
  registerTool(server, {
    name: 'book_update_booking_page',
    description: 'Update a public booking page. Provide only the fields to change. Set `enabled: false` to take a page offline without deleting it.',
    input: {
      id: z.string().uuid().describe('Booking page UUID'),
      slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional().describe('URL slug for /meet/:slug'),
      title: z.string().min(1).max(255).optional().describe('Page title'),
      description: z.string().max(2000).optional().describe('Page description'),
      duration_minutes: z.number().int().min(5).max(480).optional().describe('Meeting duration'),
      buffer_before_min: z.number().int().min(0).max(60).optional().describe('Buffer before each booking (minutes)'),
      buffer_after_min: z.number().int().min(0).max(60).optional().describe('Buffer after each booking (minutes)'),
      max_advance_days: z.number().int().min(1).max(365).optional().describe('How far ahead visitors may book (days)'),
      min_notice_hours: z.number().int().min(0).max(168).optional().describe('Minimum notice before a booking (hours)'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('Hex accent color'),
      logo_url: z.string().url().optional().describe('Logo URL'),
      confirmation_message: z.string().max(2000).optional().describe('Confirmation message shown after booking'),
      redirect_url: z.string().url().optional().describe('Redirect URL after booking'),
      auto_create_bond_contact: z.boolean().optional().describe('Auto-create a Bond contact on booking'),
      auto_create_bam_task: z.boolean().optional().describe('Auto-create a Bam task on booking'),
      bam_project_id: z.string().uuid().optional().describe('Bam project for auto-created tasks'),
      enabled: z.boolean().optional().describe('Whether the page accepts bookings'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), slug: z.string(), title: z.string() }).passthrough() }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/booking-pages/${id}`, body);
      return result.ok ? ok(result.data) : err('updating booking page', result.data);
    },
  });

  // ===== 18. book_delete_booking_page =====
  registerTool(server, {
    name: 'book_delete_booking_page',
    description: 'Delete a public booking page (scheduling link).',
    input: {
      id: z.string().uuid().describe('Booking page UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/booking-pages/${id}`);
      return result.ok ? ok(result.data) : err('deleting booking page', result.data);
    },
  });

  // ===== 19. book_get_working_hours =====
  registerTool(server, {
    name: 'book_get_working_hours',
    description: "Get the caller's weekly working-hours schedule (per day-of-week availability windows).",
    input: {},
    returns: z.object({ data: z.array(z.object({
      day_of_week: z.number().int(),
      start_time: z.string(),
      end_time: z.string(),
      timezone: z.string().optional(),
      enabled: z.boolean().optional(),
    }).passthrough()) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/working-hours');
      return result.ok ? ok(result.data) : err('getting working hours', result.data);
    },
  });

  // ===== 20. book_set_working_hours =====
  registerTool(server, {
    name: 'book_set_working_hours',
    description: "Replace the caller's weekly working-hours schedule. `day_of_week` is 0 (Sunday) through 6 (Saturday); times are HH:MM or HH:MM:SS. This is a full replace — include every day you want available.",
    input: {
      hours: z.array(z.object({
        day_of_week: z.number().int().min(0).max(6).describe('0 = Sunday … 6 = Saturday'),
        start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).describe('Window start, HH:MM or HH:MM:SS'),
        end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).describe('Window end, HH:MM or HH:MM:SS'),
        timezone: z.string().max(50).optional().describe('IANA timezone for this window'),
        enabled: z.boolean().optional().describe('Whether this window is active'),
      })).describe('Full set of working-hours windows'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }).passthrough(),
    handler: async ({ hours }) => {
      const result = await client.request('PUT', '/working-hours', hours);
      return result.ok ? ok(result.data) : err('setting working hours', result.data);
    },
  });

  // ===== 21. book_list_connections =====
  registerTool(server, {
    name: 'book_list_connections',
    description: "List the caller's external calendar connections (Google/Microsoft) and their sync status. Does not expose access tokens.",
    input: {},
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), provider: z.string().optional(), sync_direction: z.string().optional() }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/connections');
      return result.ok ? ok(result.data) : err('listing connections', result.data);
    },
  });

  // ===== 22. book_sync_connection =====
  registerTool(server, {
    name: 'book_sync_connection',
    description: 'Force an immediate sync of an existing external calendar connection.',
    input: {
      id: z.string().uuid().describe('Connection UUID'),
    },
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async ({ id }) => {
      const result = await client.request('POST', `/connections/${id}/sync`);
      return result.ok ? ok(result.data) : err('syncing connection', result.data);
    },
  });

  // ===== 23. book_delete_connection =====
  registerTool(server, {
    name: 'book_delete_connection',
    description: 'Remove an external calendar connection (Google/Microsoft).',
    input: {
      id: z.string().uuid().describe('Connection UUID'),
    },
    returns: z.object({ data: z.object({ deleted: z.boolean() }) }),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/connections/${id}`);
      return result.ok ? ok(result.data) : err('deleting connection', result.data);
    },
  });
}

// Helper: intersect two lists of time slots
function intersectSlots(
  a: Array<{ start: string; end: string }>,
  b: Array<{ start: string; end: string }>,
): Array<{ start: string; end: string }> {
  const result: Array<{ start: string; end: string }> = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const aStart = new Date(a[i]!.start).getTime();
    const aEnd = new Date(a[i]!.end).getTime();
    const bStart = new Date(b[j]!.start).getTime();
    const bEnd = new Date(b[j]!.end).getTime();

    const overlapStart = Math.max(aStart, bStart);
    const overlapEnd = Math.min(aEnd, bEnd);

    if (overlapStart < overlapEnd) {
      result.push({
        start: new Date(overlapStart).toISOString(),
        end: new Date(overlapEnd).toISOString(),
      });
    }

    if (aEnd < bEnd) i++;
    else j++;
  }

  return result;
}
