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
 * Some perception tools (`bureau_locate_user`, `bureau_get_presence`) and the
 * status tool (`bureau_set_status`) call endpoints that do not yet exist on
 * bureau-api. Those tools return an empty stub envelope and log a TODO so the
 * tool catalog is complete and agents fail soft until workstream 13 lands the
 * missing endpoints.
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
      "Locate a user inside Bureau: returns their current room_id and floor_id if they have a live session, or null otherwise. STUB: the underlying /v1/presence/locate endpoint is not yet implemented on bureau-api (workstream 13). Until then this tool returns { data: null } so agents can call it without erroring, but it cannot actually locate users. Tracked separately; agents should treat a null result as 'not located' rather than 'not in Bureau'.",
    input: {
      user_id: z.string().uuid().describe('User id to locate'),
    },
    returns: z.object({ data: z.unknown().nullable() }).passthrough(),
    handler: async ({ user_id }) => {
      const result = await client.request('GET', `/presence/locate?user=${encodeURIComponent(user_id)}`);
      if (result.ok) return ok(result.data);
      // Endpoint not implemented yet — fail soft with null so the tool catalog
      // is complete and agents can probe presence without erroring.
      if (result.status === 404 || result.status === 0) {
        return ok({ data: null, _stub: true, _todo: 'bureau-api: implement GET /v1/presence/locate (workstream 13)' });
      }
      return err('locating user', result.data);
    },
  });

  registerTool(server, {
    name: 'bureau_get_presence',
    description:
      "Snapshot the full org-wide Bureau presence map: every user with a live session, their current room, floor, and status (active/dnd/away). STUB: the underlying /v1/presence endpoint is not yet implemented on bureau-api (workstream 13). Until then this tool returns { data: [] }. Agents asking 'who is in Bureau right now?' should expect an empty list until the endpoint lands.",
    input: {},
    returns: z.object({ data: z.array(z.unknown()) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/presence');
      if (result.ok) return ok(result.data);
      if (result.status === 404 || result.status === 0) {
        return ok({ data: [], _stub: true, _todo: 'bureau-api: implement GET /v1/presence (workstream 13)' });
      }
      return err('reading bureau presence', result.data);
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
      "Set the caller's Bureau presence status: 'active', 'dnd' (Do Not Disturb — knocks are rejected with 423 Locked and the leave-a-note follow-up), or 'away'. STUB: the underlying PATCH /v1/me/status endpoint is not yet implemented on bureau-api (workstream 13). Until then the tool returns { data: { status, _stub: true } } so agents can call it without erroring, but no state actually changes.",
    input: {
      status: z.enum(['active', 'dnd', 'away']).describe('Presence status to set'),
    },
    returns: z.object({ data: z.object({ status: z.string() }).passthrough() }),
    handler: async ({ status }) => {
      const result = await client.request('PATCH', '/me/status', { status });
      if (result.ok) return ok(result.data);
      if (result.status === 404 || result.status === 0) {
        return ok({ data: { status, _stub: true }, _todo: 'bureau-api: implement PATCH /v1/me/status (workstream 13)' });
      }
      return err('setting bureau status', result.data);
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
}
