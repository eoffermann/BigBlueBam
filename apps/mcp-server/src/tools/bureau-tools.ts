import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Bureau MCP tools. Bureau is BigBlueBam's spatial-office product: floors,
 * rooms, presence, doors, knocks, bookings, and the cross-app summon system
 * built on top of LiveKit.
 *
 * Follows the same pattern as blueprint-tools.ts / board-tools.ts: a small
 * fetch wrapper that forwards the user's bearer token from the main ApiClient,
 * a `createBureauClient` factory, and per-tool `registerTool(...)` calls.
 *
 * High-impact tools (`bureau_summon`, `bureau_book_room`, `bureau_cancel_booking`)
 * use the per-tool boolean `confirm_action` flag pattern shared with
 * blueprint_archive and banter_delete_channel: call once with
 * `confirm_action: false` (or omit) to preview, then call again with
 * `confirm_action: true` to actually proceed.
 *
 * The perception tools (`bureau_locate_user`, `bureau_get_presence`) and the
 * status tool (`bureau_set_status`) are backed by the real Redis presence
 * store (workstream 13): GET /v1/presence, GET /v1/presence/locate, and
 * PATCH /v1/me/status in apps/bureau-api/src/routes/me-status.routes.ts.
 * `bureau_set_status` persists the status durably so it survives reconnects
 * and applies even when the caller has no live web session.
 */
function createBureauClient(bureauApiUrl: string, api: ApiClient) {
  const baseUrl = bureauApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client. ApiClient holds the
    // token in a private field; the rest of the MCP tools cast through
    // `unknown` to read it, so this stays consistent across modules.
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
    // 204 No Content has no body; guard the JSON parse so DELETEs do not
    // throw at the await boundary.
    let data: unknown = null;
    if (res.status !== 204) {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
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

// ─── Shared shapes ──────────────────────────────────────────────────────

const floorShape = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid().optional(),
  name: z.string(),
  slug: z.string(),
  layout: z.record(z.unknown()).nullable().optional(),
  background_url: z.string().nullable().optional(),
  building_id: z.string().uuid().nullable().optional(),
  position: z.number().int().optional(),
  is_default: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const roomShape = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid().optional(),
  floor_id: z.string().uuid().optional(),
  name: z.string(),
  type: z.string(),
  privacy_default: z.string().optional(),
  capacity: z.number().int().nullable().optional(),
  bookable: z.boolean().optional(),
  zone_id: z.string().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  occupants: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const knockShape = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid().optional(),
  room_id: z.string().uuid(),
  visitor_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  status: z.string(),
  message: z.string().nullable().optional(),
  created_at: z.string().optional(),
  resolved_at: z.string().nullable().optional(),
}).passthrough();

const bookingShape = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid().optional(),
  room_id: z.string().uuid(),
  book_event_id: z.string().uuid().nullable().optional(),
  organizer_id: z.string().uuid().optional(),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  access: z.string().optional(),
  created_at: z.string().optional(),
  cancelled_at: z.string().nullable().optional(),
}).passthrough();

const livekitTokenShape = z.object({
  token: z.string(),
  room_name: z.string(),
  ws_url: z.string(),
}).passthrough();

const summonResultShape = z.object({
  summon_id: z.string().uuid(),
  from_room_id: z.string().uuid().nullable().optional(),
  eligible_count: z.number().int(),
  denied_count: z.number().int(),
  can_share: z.boolean().optional(),
}).passthrough();

export function registerBureauTools(
  server: McpServer,
  api: ApiClient,
  bureauApiUrl: string,
): void {
  const client = createBureauClient(bureauApiUrl, api);

  // ============================================================
  // PERCEPTION (5) — read-only, no confirmation required
  // ============================================================

  registerTool(server, {
    name: 'bureau_list_floors',
    description:
      "List every Bureau floor in the caller's org, including live occupancy counts (from Redis) and the floor's default status. A Bureau floor is the top-level spatial container that holds rooms; orgs typically have one or two floors at first and add buildings/wings as they grow. Use bureau_get_floor for the rooms+layout payload.",
    input: {},
    returns: z.object({ data: z.array(floorShape) }),
    handler: async () => {
      const result = await client.request('GET', '/floors');
      return result.ok ? ok(result.data) : err('listing bureau floors', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_list_rooms',
    description:
      "List rooms across the caller's org (live, non-archived), each joined with its floor name, type, capacity, and bookable flag. Pass bookable: true to restrict to reservable rooms (the set bureau_book_room accepts), or floor_id to scope to one floor. Use this to find a room id to book without walking every floor via bureau_get_floor.",
    input: {
      bookable: z.boolean().optional().describe('When true, return only bookable rooms'),
      floor_id: z.string().uuid().optional().describe('Restrict to one floor'),
    },
    returns: z.object({ data: z.array(roomShape) }),
    handler: async ({ bookable, floor_id }) => {
      const qs = buildQs({ bookable: bookable ? '1' : undefined, floor_id });
      const result = await client.request('GET', `/rooms${qs}`);
      return result.ok ? ok(result.data) : err('listing bureau rooms', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_get_floor',
    description:
      "Fetch a single Bureau floor by id, including its rooms array (with live per-room occupancy), background image, and layout JSON. Use this to render the floor view or to enumerate rooms before bureau_who_is_in_room / bureau_move_self.",
    input: {
      id: z.string().uuid().describe('Floor id'),
    },
    returns: z.object({ data: floorShape }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/floors/${id}`);
      return result.ok ? ok(result.data) : err('getting bureau floor', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_who_is_in_room',
    description:
      "Get a room's detail and its current occupants (user_ids of every live Bureau session present in the room). Access-filtered: the bureau-api applies the same evaluator used for room-entry, so private rooms return 404 to callers who are not on the ACL. Use this BEFORE bureau_summon or bureau_knock so an agent can decide who would actually be summoned/disturbed.",
    input: {
      id: z.string().uuid().describe('Room id'),
    },
    returns: z.object({ data: roomShape }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/rooms/${id}`);
      return result.ok ? ok(result.data) : err('reading bureau room', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_locate_user',
    description:
      "Locate a user inside Bureau: returns their current room_id and floor_id (plus status and the surface URL they are on) if they have a live presence session in the caller's org, or { data: null } when they have none. Backed by the live Redis presence sessions the floor view uses. A null result means 'not currently on Bureau in your org' (offline, or active in a different org). For cross-app location by surface URL (which app/page they are on, with a destination-access preflight) prefer bureau_where_is_user; this tool answers the spatial 'which room/floor' question.",
    input: {
      user_id: z.string().uuid().describe('User id to locate'),
    },
    returns: z
      .object({
        data: z
          .object({
            user_id: z.string().uuid(),
            room_id: z.string().uuid().nullable(),
            floor_id: z.string().uuid().nullable(),
            status: z.string().optional(),
            location_url: z.string().nullable().optional(),
            location_app: z.string().nullable().optional(),
            location_label: z.string().nullable().optional(),
          })
          .nullable(),
      })
      .passthrough(),
    handler: async ({ user_id }) => {
      const result = await client.request('GET', `/presence/locate?user=${encodeURIComponent(user_id)}`);
      return result.ok ? ok(result.data) : err('locating user', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_get_presence',
    description:
      "Snapshot the full org-wide Bureau presence map: every user with a live session in the caller's org, with their current room_id, floor_id, status (available/busy/dnd/focus/away/in_meeting), and the surface URL/app they are on. Reads the live Redis presence sessions that drive the floor view and the floating presence widget. An empty list means nobody in your org has a live Bureau session right now. Use bureau_locate_user for a single user, or bureau_who_is_in_room for one room's occupants.",
    input: {},
    returns: z
      .object({
        data: z.array(
          z
            .object({
              user_id: z.string().uuid(),
              display_name: z.string().nullable().optional(),
              avatar_url: z.string().nullable().optional(),
              status: z.string(),
              room_id: z.string().uuid().nullable(),
              floor_id: z.string().uuid().nullable(),
              location_url: z.string().nullable().optional(),
              location_app: z.string().nullable().optional(),
              location_label: z.string().nullable().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/presence');
      return result.ok ? ok(result.data) : err('reading bureau presence', result.data);
    },
  });

  // ============================================================
  // SELF-MOVEMENT & STATUS (3)
  // ============================================================

  registerTool(server, {
    name: 'bureau_move_self',
    description:
      "Move the caller into a Bureau room: mints a LiveKit access token for `bureau-room-{id}` and records the session on the server. This is the canonical 'enter a room' tool — calling it is what makes the caller appear in bureau_who_is_in_room and bureau_get_presence. Returns { token, room_name, ws_url } so the client can connect to LiveKit. Token TTL is 3600s. The bureau-api gates the call by privacy (open / knock / private) and ACL; private rooms without an ACL entry return 403.",
    input: {
      id: z.string().uuid().describe('Target room id'),
    },
    returns: z.object({ data: livekitTokenShape }),
    handler: async ({ id }) => {
      const result = await client.request('POST', `/rooms/${id}/token`);
      return result.ok ? ok(result.data) : err('moving into bureau room', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_set_status',
    description:
      "Set AND persist the caller's Bureau presence status: 'available', 'busy', 'away', or 'dnd' (Do Not Disturb — knocks are rejected with 423 Locked and the leave-a-note follow-up). The status is stored durably (it survives reconnects and applies even when the caller has no live web session — e.g. an agent setting its own status over MCP) and is fanned out to every live session immediately so the floor view and the floating presence widget repaint at once. Returns { status, live_sessions, persisted } where live_sessions is how many live sessions were updated (0 is normal for an agent with no open floor view; the durable status still persisted). Read it back with bureau_get_presence or bureau_locate_user.",
    input: {
      status: z
        .enum(['available', 'busy', 'away', 'dnd'])
        .describe('Presence status to set'),
    },
    returns: z.object({
      data: z
        .object({
          status: z.string(),
          live_sessions: z.number().int().optional(),
          persisted: z.boolean().optional(),
        })
        .passthrough(),
    }),
    handler: async ({ status }) => {
      const result = await client.request('PATCH', '/me/status', { status });
      return result.ok ? ok(result.data) : err('setting bureau status', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_set_door_state',
    description:
      "Update the durable default privacy ('door state') of a room: 'open' (anyone can enter), 'knock' (visitors must knock), or 'private' (ACL-only). Only callable by the office's owner for type='office' rooms, by a room manager for shared rooms, or by org admins/owners. Live overrides (e.g. a short DND window) live in Redis and are managed separately by the bureau-client SDK; this sets the fallback that renders when no override is active.",
    input: {
      id: z.string().uuid().describe('Room id'),
      privacy: z.enum(['open', 'knock', 'private']).describe('New default privacy'),
    },
    returns: z.object({ data: roomShape }),
    handler: async ({ id, privacy }) => {
      const result = await client.request('PATCH', `/rooms/${id}/door`, { privacy });
      return result.ok ? ok(result.data) : err('setting bureau room door', result.data);
    },
  });

  // ============================================================
  // SOCIAL (2)
  // ============================================================

  registerTool(server, {
    name: 'bureau_knock',
    description:
      "Knock on an office door — creates a pending bureau_knocks row, emits a knock.requested Bolt event, and schedules a 30s timeout that flips the knock to 'timed_out' if the owner does not respond. Only callable on type='office' rooms with an owner; callers cannot knock on their own office. If the owner is currently in DND the call returns 423 Locked with a 'leave a note' follow-up endpoint pointer — agents should surface that to the caller rather than retry blindly.",
    input: {
      room_id: z.string().uuid().describe('Office room id to knock on'),
      message: z.string().max(1000).optional().describe('Optional visitor message shown to the office owner'),
    },
    returns: z.object({ data: knockShape }),
    handler: async (body) => {
      const result = await client.request('POST', '/knocks', body);
      return result.ok ? ok(result.data) : err('knocking on bureau room', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_respond_knock',
    description:
      "Resolve a pending knock as the office owner: 'admit' (visitor is allowed in — visitor gets a WS push with a fresh LiveKit token), 'defer' (owner is busy now, the knock is parked but visitor is told), or 'decline' (visitor sees a polite rejection). Only the owner_id on the knock row may patch it. Setting status emits knock.resolved on Bolt.",
    input: {
      id: z.string().uuid().describe('Knock id'),
      decision: z.enum(['admit', 'defer', 'decline']).describe('Knock resolution'),
    },
    returns: z.object({ data: knockShape }),
    handler: async ({ id, decision }) => {
      const result = await client.request('PATCH', `/knocks/${id}`, { decision });
      return result.ok ? ok(result.data) : err('responding to bureau knock', result.data);
    },
  });

  // ============================================================
  // BOOKING (3) — bureau_book_room + bureau_cancel_booking use confirm_action
  // ============================================================

  registerTool(server, {
    name: 'bureau_book_room',
    description:
      "Reserve a Bureau room for a time window. The booking writes a bureau_bookings row, anchors it to a Book event (best-effort — falls back to a self-minted uuid if book-api is down), and schedules two BullMQ jobs: one at starts_at that flips the room privacy override to 'private' and emits room.booked, one at ends_at that clears the override. `access: 'locked'` keeps the room private for the booking; `access: 'open'` lets anyone wander in. " +
      "HIGH-IMPACT — requires confirm_action=true to actually proceed. Call once with confirm_action: false (or omit) to preview the booking, then call again with true to commit.",
    input: {
      id: z.string().uuid().describe('Room id to book'),
      title: z.string().min(1).max(200).describe('Booking title shown in calendars'),
      starts_at: z.string().datetime({ offset: true }).describe('Start time (ISO-8601 with offset)'),
      ends_at: z.string().datetime({ offset: true }).describe('End time (ISO-8601 with offset)'),
      access: z.enum(['open', 'locked']).optional().describe("'open' lets non-attendees wander in; 'locked' (default behavior) holds the room private for the meeting"),
      book_event_id: z.string().uuid().optional().describe('Optional Book event id to anchor against (skips the internal book-api call)'),
      confirm_action: z.boolean().describe('Must be true to actually book. Call once with false (or omit) to preview, then call again with true.'),
    },
    returns: z.object({ data: bookingShape }),
    handler: async ({ id, confirm_action, ...body }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: book room ${id} as "${body.title}" from ${body.starts_at} to ${body.ends_at} (access: ${body.access ?? 'open'}). Call bureau_book_room again with confirm_action: true to commit. This reserves the room for the entire window and may create or anchor a Book event.`,
          }],
        };
      }
      const result = await client.request('POST', `/rooms/${id}/bookings`, body);
      return result.ok ? ok(result.data) : err('booking bureau room', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_list_bookings',
    description:
      "List the active (non-cancelled) bookings for a Bureau room that overlap the given window. Defaults to the next 7 days from now. Returned bookings include the book_event_id back-link so the caller can cross-reference Book calendar entries.",
    input: {
      id: z.string().uuid().describe('Room id'),
      from: z.string().datetime({ offset: true }).optional().describe('Window start (defaults to now)'),
      to: z.string().datetime({ offset: true }).optional().describe('Window end (defaults to now + 7 days)'),
    },
    returns: z.object({ data: z.object({ bookings: z.array(bookingShape), window: z.object({ from: z.string(), to: z.string() }).passthrough() }).passthrough() }),
    handler: async ({ id, ...query }) => {
      const result = await client.request('GET', `/rooms/${id}/bookings${buildQs(query)}`);
      return result.ok ? ok(result.data) : err('listing bureau bookings', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_cancel_booking',
    description:
      "Cancel a Bureau booking (sets cancelled_at, removes the lifecycle jobs, best-effort cancels the linked Book event). Cancellation is a soft delete — the row stays for auditability. " +
      "Requires confirm_action=true to actually cancel. Call once with confirm_action: false (or omit) to preview, then call again with true. This affects calendar invites and may notify attendees via Book.",
    input: {
      id: z.string().uuid().describe('Booking id to cancel'),
      confirm_action: z.boolean().describe('Must be true to actually cancel. Call once with false (or omit) to preview.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), cancelled: z.boolean() }).passthrough() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: cancel bureau booking ${id}. This soft-deletes the booking, clears the room's scheduled privacy override, and attempts to cancel the linked Book event. Call bureau_cancel_booking again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('DELETE', `/bookings/${id}`);
      if (result.ok) return ok({ data: { id, cancelled: true } });
      return err('cancelling bureau booking', result.data);
    },
  });

  // ============================================================
  // TELEPORT (1) — HIGH IMPACT, confirm_action
  // ============================================================

  registerTool(server, {
    name: 'bureau_summon',
    description:
      "Summon every eligible occupant of the caller's current Bureau room to a URL in another product (Board, Brief, Bond, etc.). The bureau-api runs cross-app access checks for each recipient against the target_url so denied users are NOT pinged with a dead-link; their ids land on the denied list so the summoner can offer §4.4 'grant access' as a follow-up via bureau_summon's denied_count. " +
      "HIGH IMPACT — this DMs every eligible co-occupant in real time. Requires confirm_action=true to actually summon. Call once with confirm_action: false (or omit) to preview, then call again with true. The caller MUST be in a Bureau room or the call fails with 400.",
    input: {
      target_url: z.string().describe("Destination URL the summoned users will be jumped to (e.g. https://app/board/abc?lkRoom=board-room-xyz)"),
      target_app: z.string().min(1).max(24).describe("App slug — 'board' | 'brief' | 'bond' | 'banter' | etc. Used by the recipient client to choose the right dock and authorization preflight."),
      target_label: z.string().max(200).optional().describe('Human-friendly label shown in the incoming-summon toast (e.g. "Q3 Roadmap")'),
      lk_room_hint: z.string().max(96).optional().describe('Optional LiveKit room hint so the recipient can join the same room without a second negotiation hop'),
      confirm_action: z.boolean().describe('Must be true to actually summon. Call once with false (or omit) to preview the planned recipients, then call again with true.'),
    },
    returns: z.object({ data: summonResultShape }),
    handler: async ({ confirm_action, ...body }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: summon co-occupants to ${body.target_url} (app=${body.target_app}${body.target_label ? `, label="${body.target_label}"` : ''}${body.lk_room_hint ? `, lk_room_hint=${body.lk_room_hint}` : ''}). This will DM every eligible user currently sharing your Bureau room in real time. Call bureau_summon again with confirm_action: true to send it.`,
          }],
        };
      }
      const result = await client.request('POST', '/summon', body);
      return result.ok ? ok(result.data) : err('summoning bureau users', result.data);
    },
  });

  // ============================================================
  // ADMINISTRATION (3) — admin/owner gated server-side
  // ============================================================

  registerTool(server, {
    name: 'bureau_create_floor',
    description:
      "Create a new Bureau floor. Org admins/owners only (gated server-side; non-admins receive 403). `slug` is the URL-safe identifier — lowercase alphanumeric with dashes, 1-140 chars. `is_default: true` marks the floor as the org's landing floor (only one can be default at a time). `layout` is a free-form JSON describing the floor's wallpaper/rooms-arrangement for the Canvas2D floor view; pass {} for an empty layout that admins fill in via the UI.",
    input: {
      name: z.string().min(1).max(120).describe('Display name'),
      slug: z.string().min(1).max(140).regex(/^[a-z0-9-]+$/).describe('URL slug — lowercase alphanumeric with dashes'),
      layout: z.record(z.unknown()).optional().describe('Free-form Canvas2D layout payload (rooms-arrangement, wallpaper, etc.)'),
      background_url: z.string().max(2048).nullable().optional().describe('Optional floor background image URL'),
      building_id: z.string().uuid().nullable().optional().describe('Optional building this floor belongs to (for multi-building orgs)'),
      position: z.number().int().min(0).optional().describe('Sort order in the floor list (lower = earlier)'),
      is_default: z.boolean().optional().describe("If true, mark this as the org's default floor"),
    },
    returns: z.object({ data: floorShape }),
    handler: async (body) => {
      const result = await client.request('POST', '/floors', body);
      return result.ok ? ok(result.data) : err('creating bureau floor', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_create_room',
    description:
      "Create a new Bureau room on an existing floor. `type` is the room kind: 'office' (single-occupant, can be knocked on), 'huddle' / 'conference' / 'meeting' / 'open' / 'lounge' / 'focus' / 'lobby'. `privacy_default` controls the door state at boot ('open' | 'knock' | 'private'). `bookable: true` makes the room appear in bureau_book_room. `owner_id` is required for type='office' so the knock system has someone to admit visitors. Server-side gate: org admins/owners can always create; non-admins only if bureau_settings.members_can_create_rooms is true.",
    input: {
      name: z.string().min(1).max(120).describe('Room display name'),
      type: z
        .enum(['office', 'huddle', 'conference', 'meeting', 'open', 'lounge', 'focus', 'lobby'])
        .describe('Room kind'),
      floor_id: z.string().uuid().describe('Parent floor id'),
      capacity: z.number().int().min(1).nullable().optional().describe('Static capacity ceiling; live occupancy is enforced separately'),
      privacy_default: z.enum(['open', 'knock', 'private']).optional().describe("Default door privacy (default 'open')"),
      bookable: z.boolean().optional().describe('Whether the room can be reserved via bureau_book_room (default false)'),
      zone_id: z.string().min(1).max(64).describe('Zone identifier within the floor — groups rooms for layout / Canvas2D rendering'),
      owner_id: z.string().uuid().nullable().optional().describe("For type='office', the user who occupies it (knock target). Null for shared rooms."),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary structured metadata attached to the room'),
    },
    returns: z.object({ data: roomShape }),
    handler: async (body) => {
      const result = await client.request('POST', '/rooms', body);
      return result.ok ? ok(result.data) : err('creating bureau room', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_update_room',
    description:
      "Update fields on a Bureau room. Provide only the fields to change. Server-side gate: org admins/owners, the office's owner_id (for type='office'), or a room manager via bureau_room_acl. To change the live door state use bureau_set_door_state instead — this tool only updates the durable defaults.",
    input: {
      id: z.string().uuid().describe('Room id'),
      name: z.string().min(1).max(120).optional().describe('Updated display name'),
      type: z
        .enum(['office', 'huddle', 'conference', 'meeting', 'open', 'lounge', 'focus', 'lobby'])
        .optional()
        .describe('Updated room kind'),
      capacity: z.number().int().min(1).nullable().optional().describe('Updated capacity (null clears the cap)'),
      privacy_default: z.enum(['open', 'knock', 'private']).optional().describe('Updated default door privacy'),
      bookable: z.boolean().optional().describe('Updated bookable flag'),
      zone_id: z.string().min(1).max(64).optional().describe('Updated zone id'),
      owner_id: z.string().uuid().nullable().optional().describe("Updated office owner (null detaches; only meaningful for type='office')"),
      metadata: z.record(z.unknown()).optional().describe('Updated metadata JSON'),
    },
    returns: z.object({ data: roomShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/rooms/${id}`, body);
      return result.ok ? ok(result.data) : err('updating bureau room', result.data);
    },
  });

  // ============================================================
  // FLOORS — additional (update / background / delete)
  // ============================================================

  registerTool(server, {
    name: 'bureau_update_floor',
    description:
      "Update a Bureau floor's metadata. Provide only the fields to change. Org admins/owners only (gated server-side; non-admins get 403). To UNARCHIVE a soft-deleted floor, pass archived_at: null — that is the only PATCH that can target an archived floor, and it is the symmetric undo of bureau_delete_floor. Any field-only PATCH (name/layout/etc.) requires the floor to be live. `slug` and `building_id` are immutable here (set them at create time).",
    input: {
      id: z.string().uuid().describe('Floor id'),
      name: z.string().min(1).max(120).optional().describe('Updated display name'),
      layout: z.record(z.unknown()).optional().describe('Updated free-form Canvas2D layout payload'),
      background_url: z.string().max(2048).nullable().optional().describe('Updated floor background image URL (null clears it)'),
      position: z.number().int().min(0).optional().describe('Updated sort order (lower = earlier)'),
      is_default: z.boolean().optional().describe("Mark/unmark this as the org's default floor"),
      archived_at: z.null().optional().describe('Pass null to unarchive (restore) a soft-deleted floor. No other value is accepted.'),
    },
    returns: z.object({ data: floorShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/floors/${id}`, body);
      return result.ok ? ok(result.data) : err('updating bureau floor', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_set_floor_background',
    description:
      "Set a Bureau floor's background image URL. Org admins/owners only (gated server-side). This only stores the URL string on the floor row — uploading the image to object storage is a separate concern handled by the UI. Use bureau_update_floor with background_url: null to clear it.",
    input: {
      id: z.string().uuid().describe('Floor id'),
      background_url: z.string().min(1).max(2048).describe('Background image URL to store on the floor'),
    },
    returns: z.object({ data: floorShape }),
    handler: async ({ id, background_url }) => {
      const result = await client.request('POST', `/floors/${id}/background`, { background_url });
      return result.ok ? ok(result.data) : err('setting bureau floor background', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_delete_floor',
    description:
      "Soft-delete (archive) a Bureau floor. Org admins/owners only (gated server-side). This is a soft delete — the row stays and can be restored with bureau_update_floor (archived_at: null). Archiving a floor hides it and its rooms from the floor view. " +
      "Requires confirm_action=true to actually delete. Call once with confirm_action: false (or omit) to preview, then call again with true.",
    input: {
      id: z.string().uuid().describe('Floor id to archive'),
      confirm_action: z.boolean().describe('Must be true to actually archive. Call once with false (or omit) to preview.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), archived: z.boolean() }).passthrough() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: archive (soft-delete) Bureau floor ${id}. This hides the floor and its rooms from the floor view; the row is retained and can be restored via bureau_update_floor with archived_at: null. Call bureau_delete_floor again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('DELETE', `/floors/${id}`);
      if (result.ok) return ok({ data: { id, archived: true } });
      return err('deleting bureau floor', result.data);
    },
  });

  // ============================================================
  // ROOMS — additional (delete)
  // ============================================================

  registerTool(server, {
    name: 'bureau_delete_room',
    description:
      "Soft-delete (archive) a Bureau room. Org admins/owners only (gated server-side). This is a soft delete — the row is retained for auditability but the room disappears from the floor and can no longer be entered, booked, or knocked on. " +
      "Requires confirm_action=true to actually delete. Call once with confirm_action: false (or omit) to preview, then call again with true.",
    input: {
      id: z.string().uuid().describe('Room id to archive'),
      confirm_action: z.boolean().describe('Must be true to actually archive. Call once with false (or omit) to preview.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), archived: z.boolean() }).passthrough() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: archive (soft-delete) Bureau room ${id}. The room will disappear from its floor and can no longer be entered, booked, or knocked on. Call bureau_delete_room again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('DELETE', `/rooms/${id}`);
      if (result.ok) return ok({ data: { id, archived: true } });
      return err('deleting bureau room', result.data);
    },
  });

  // ============================================================
  // BOOKING — additional (update window)
  // ============================================================

  registerTool(server, {
    name: 'bureau_update_booking',
    description:
      "Update a Bureau booking's title, time window, or access. Provide only the fields to change. Only the organizer or an org admin/owner may update a booking; cancelled bookings cannot be edited. Changing the window re-schedules the lifecycle jobs (privacy lock at starts_at, release at ends_at). To get a booking id, use bureau_list_bookings on the room (there is no standalone booking GET).",
    input: {
      id: z.string().uuid().describe('Booking id'),
      title: z.string().min(1).max(200).optional().describe('Updated booking title'),
      starts_at: z.string().datetime({ offset: true }).optional().describe('Updated start time (ISO-8601 with offset)'),
      ends_at: z.string().datetime({ offset: true }).optional().describe('Updated end time (ISO-8601 with offset)'),
      access: z.enum(['open', 'locked']).optional().describe("'open' lets non-attendees wander in; 'locked' holds the room private"),
    },
    returns: z.object({ data: bookingShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/bookings/${id}`, body);
      return result.ok ? ok(result.data) : err('updating bureau booking', result.data);
    },
  });

  // ============================================================
  // OFFICES (3) — personal-office assignment + lookup
  // ============================================================

  registerTool(server, {
    name: 'bureau_list_offices',
    description:
      "List every type='office' room across the org's live floors, joined with each office's current owner (display name, email, avatar) and floor name. Org admins/owners only (gated server-side; non-admins get 403). Use this to see who has a personal office before bureau_assign_office.",
    input: {},
    returns: z.object({ data: z.array(z.object({
      id: z.string().uuid(),
      floor_id: z.string().uuid(),
      floor_name: z.string().nullable().optional(),
      name: z.string(),
      type: z.string(),
      privacy_default: z.string().optional(),
      owner: z.object({ id: z.string().uuid(), display_name: z.string().nullable().optional(), email: z.string().nullable().optional(), avatar_url: z.string().nullable().optional() }).nullable().optional(),
      updated_at: z.string().optional(),
    }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/offices');
      return result.ok ? ok(result.data) : err('listing bureau offices', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_assign_office',
    description:
      "Assign a Bureau room (office) to a user as its owner — the user becomes the room's occupant and knock target. Org admins/owners only (gated server-side; non-admins get 403). The target user must be an active member of the org. Assignment is org-scoped; any non-archived room can be assigned (the floor designer may repurpose a huddle as an office), though the admin offices view only surfaces type='office' rooms.",
    input: {
      room_id: z.string().uuid().describe('Room id to assign'),
      user_id: z.string().uuid().describe('User id to make the owner/occupant'),
    },
    returns: z.object({ data: roomShape }),
    handler: async (body) => {
      const result = await client.request('POST', '/offices/assign', body);
      return result.ok ? ok(result.data) : err('assigning bureau office', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_my_office',
    description:
      "Return the Bureau room owned by the caller (their personal office), or { data: null } if they have none. Use this to find the caller's home room before bureau_set_door_state or bureau_move_self.",
    input: {},
    returns: z.object({ data: roomShape.nullable() }),
    handler: async () => {
      const result = await client.request('GET', '/offices/mine');
      return result.ok ? ok(result.data) : err('getting caller bureau office', result.data);
    },
  });

  // ============================================================
  // KNOCKS — additional (inbox / leave-note)
  // ============================================================

  registerTool(server, {
    name: 'bureau_knock_inbox',
    description:
      "List the pending knocks where the caller is the office owner — i.e. visitors currently waiting at the caller's door. Newest first. Resolve each with bureau_respond_knock (admit/defer/decline). Knocks that timed out (no response within 30s) are not pending and won't appear here.",
    input: {},
    returns: z.object({ data: z.array(knockShape) }),
    handler: async () => {
      const result = await client.request('GET', '/knocks/inbox');
      return result.ok ? ok(result.data) : err('listing bureau knock inbox', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_leave_note',
    description:
      "Leave a note for an office owner who is in Do Not Disturb — the DND fallback for bureau_knock (which returns 423 Locked when the owner is in DND). Delivers the message as a Banter DM to the owner, prefixed '[Bureau knock note] '. Only valid for type='office' rooms with an owner; you cannot leave a note on your own office. Returns { delivered: true } when the DM was posted, or { delivered: false } (HTTP 202) if Banter was unreachable and the note was dropped — surface that to the caller rather than assuming success.",
    input: {
      room_id: z.string().uuid().describe('Office room id whose owner should receive the note'),
      message: z.string().min(1).max(2000).describe('The note text to DM the owner'),
    },
    returns: z.object({ data: z.object({ delivered: z.boolean() }).passthrough() }),
    handler: async (body) => {
      const result = await client.request('POST', '/knocks/leave-note', body);
      return result.ok ? ok(result.data) : err('leaving bureau note', result.data);
    },
  });

  // ============================================================
  // PRESENCE — real endpoints (co-presence by URL / locate a user)
  // ============================================================

  registerTool(server, {
    name: 'bureau_who_is_here',
    description:
      "Co-presence by URL: list OTHER users currently on the same content surface (the given canonical URL) according to their live Bureau session — for the 'X others here' chip and starting a huddle. Deduped by user (multiple devices collapse to one), excludes the caller, and access-filtered: if the CALLER cannot see the destination URL the result is empty. This reads live, ephemeral presence state; an empty list means nobody else is reporting that exact URL right now.",
    input: {
      url: z.string().min(1).max(2048).describe('Canonical surface URL to check co-presence on (must match what the SDK reports)'),
    },
    returns: z.object({ data: z.array(z.object({
      user_id: z.string().uuid(),
      display_name: z.string().nullable().optional(),
      avatar_url: z.string().nullable().optional(),
      status: z.string().optional(),
      status_emoji: z.string().nullable().optional(),
    }).passthrough()) }),
    handler: async ({ url }) => {
      const result = await client.request('GET', `/presence/here${buildQs({ url })}`);
      return result.ok ? ok(result.data) : err('reading bureau co-presence', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_where_is_user',
    description:
      "Locate a specific user ('Hunt'): returns the URL/app/label/status of the surface the target user is currently on, so the caller can jump to them. Returns { data: { located: true, url, app, label, status } } or { data: { located: false } } when the user is offline, in Do Not Disturb, in a different org right now, or on a surface the CALLER cannot see (denial is indistinguishable from absence). This is the real, implemented locate endpoint (unlike the bureau_locate_user stub); prefer this tool. The target must share the caller's active org.",
    input: {
      user_id: z.string().uuid().describe('User id to locate'),
    },
    returns: z.object({ data: z.object({
      located: z.boolean(),
      url: z.string().optional(),
      app: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
      status: z.string().optional(),
    }).passthrough() }),
    handler: async ({ user_id }) => {
      const result = await client.request('GET', `/presence/where/${user_id}`);
      return result.ok ? ok(result.data) : err('locating bureau user', result.data);
    },
  });

  // ============================================================
  // SUMMON — additional (audit lookup / grant-access follow-up)
  // ============================================================

  registerTool(server, {
    name: 'bureau_get_summon',
    description:
      "Fetch a summon audit row by id: who summoned, from which room, the target URL/app, and the eligible/denied recipient lists. Only the original summoner (or an org admin/owner) may read it. Use this after bureau_summon to inspect who was eligible vs denied, then optionally bureau_summon_grant_access to grant the denied users and re-summon them.",
    input: {
      id: z.string().uuid().describe('Summon id'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), summoner_id: z.string().uuid().optional(), from_room_id: z.string().uuid().nullable().optional(), target_url: z.string().optional(), target_app: z.string().optional() }).passthrough() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/summons/${id}`);
      return result.ok ? ok(result.data) : err('getting bureau summon', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_summon_grant_access',
    description:
      "§4.4 grant-and-summon follow-up: for users who were DENIED on a prior summon (because they lacked access to the target URL), grant them access AND re-summon them in one step. Only the original summoner may call this on their own summon. Get the summon id and the denied user ids from bureau_get_summon. " +
      "HIGH IMPACT — this grants cross-app access to the target resource AND DMs each user a real-time summon. Requires confirm_action=true to proceed. Call once with confirm_action: false (or omit) to preview, then call again with true.",
    input: {
      id: z.string().uuid().describe('Summon id to grant access on'),
      user_ids: z.array(z.string().uuid()).min(1).max(100).describe('User ids (from the summon\'s denied list) to grant access and re-summon'),
      confirm_action: z.boolean().describe('Must be true to actually grant + summon. Call once with false (or omit) to preview.'),
    },
    returns: z.object({ data: z.object({ granted: z.unknown(), missing: z.unknown() }).passthrough() }),
    handler: async ({ id, user_ids, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Preview: grant access to ${user_ids.length} user(s) on summon ${id} and re-summon them to the target surface. This grants cross-app access to the target resource and DMs each user in real time. Call bureau_summon_grant_access again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('POST', `/summons/${id}/grant-access`, { user_ids });
      return result.ok ? ok(result.data) : err('granting bureau summon access', result.data);
    },
  });

  // ============================================================
  // CHAT (3) — room-chat recovery + retention
  // ============================================================

  registerTool(server, {
    name: 'bureau_list_chats',
    description:
      "List the Bureau room-chat threads the caller participated in (the recovery half of room chat — the live half is WS-only). Optional `search` filters by thread. Use the returned room keys with bureau_get_chat_messages to read a transcript.",
    input: {
      search: z.string().max(255).optional().describe('Optional search filter over the caller\'s chat threads'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async ({ search }) => {
      const result = await client.request('GET', `/chat/rooms${buildQs({ search })}`);
      return result.ok ? ok(result.data) : err('listing bureau chats', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_get_chat_messages',
    description:
      "Recover the transcript of a Bureau room chat by its room key. Access is gated by participation: you can re-read what you were present for; org admins/owners and SuperUsers can additionally read any thread they can name. Returns up to `limit` messages (default 100, max 200), oldest-first within the page; pass `before` (ISO-8601) to page backwards in time.",
    input: {
      room_key: z.string().min(1).max(255).describe('Chat room key (from bureau_list_chats)'),
      before: z.string().datetime({ offset: true }).optional().describe('Return messages created before this timestamp (ISO-8601) for pagination'),
      limit: z.number().int().positive().max(200).optional().describe('Max messages to return (default 100, max 200)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async ({ room_key, ...query }) => {
      const result = await client.request('GET', `/chat/rooms/${encodeURIComponent(room_key)}/messages${buildQs(query)}`);
      return result.ok ? ok(result.data) : err('reading bureau chat messages', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_set_chat_retention',
    description:
      "Set the retention policy on a Bureau room chat. Org admins/owners and SuperUsers only (gated server-side; others get 403). Provide retention_hours (1..168, i.e. up to one week) to extend, OR retain_forever: true to keep the transcript indefinitely. At least one must be given.",
    input: {
      room_key: z.string().min(1).max(255).describe('Chat room key'),
      retention_hours: z.number().int().min(1).max(168).optional().describe('Hours to retain the transcript (1..168 = up to one week)'),
      retain_forever: z.boolean().optional().describe('Keep the transcript indefinitely'),
    },
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async ({ room_key, ...body }) => {
      const result = await client.request('PATCH', `/chat/rooms/${encodeURIComponent(room_key)}/retention`, body);
      return result.ok ? ok(result.data) : err('setting bureau chat retention', result.data);
    },
  });

  // ============================================================
  // SETTINGS (2) — org Bureau preferences
  // ============================================================

  registerTool(server, {
    name: 'bureau_get_settings',
    description:
      "Get the org-wide Bureau settings (continuous_audio, allow_auto_follow, default_office_privacy, members_can_book, members_can_create_rooms). Creates and returns a default row if none exists yet. Readable by any member; mutating requires bureau_update_settings (admin/owner).",
    input: {},
    returns: z.object({ data: z.object({
      org_id: z.string().uuid().optional(),
      continuous_audio: z.boolean().optional(),
      allow_auto_follow: z.boolean().optional(),
      default_office_privacy: z.string().optional(),
      members_can_book: z.boolean().optional(),
      members_can_create_rooms: z.boolean().optional(),
    }).passthrough() }),
    handler: async () => {
      const result = await client.request('GET', '/settings');
      return result.ok ? ok(result.data) : err('getting bureau settings', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_update_settings',
    description:
      "Update the org-wide Bureau settings. Org admins/owners only (gated server-side; non-admins get 403). Provide only the fields to change. `members_can_book` gates whether non-admins may reserve rooms; `members_can_create_rooms` gates whether non-admins may create rooms; `default_office_privacy` is the door state new offices boot with.",
    input: {
      continuous_audio: z.boolean().optional().describe('Whether always-on spatial audio is enabled for the org'),
      allow_auto_follow: z.boolean().optional().describe('Whether auto-follow (being pulled along on navigation) is permitted'),
      default_office_privacy: z.enum(['open', 'knock', 'private']).optional().describe('Default door privacy new offices boot with'),
      members_can_book: z.boolean().optional().describe('Whether non-admin members may book rooms'),
      members_can_create_rooms: z.boolean().optional().describe('Whether non-admin members may create rooms'),
    },
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async (body) => {
      const result = await client.request('PATCH', '/settings', body);
      return result.ok ? ok(result.data) : err('updating bureau settings', result.data);
    },
  });
}
