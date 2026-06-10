/**
 * Bureau Bolt event emitters (Agent C, workstream 2).
 *
 * Thin typed wrappers around `publishBoltEvent` from @bigbluebam/shared so
 * route handlers in other workstreams can fire Bolt events without
 * memorising the bare-name convention. Each helper:
 *
 *   - Uses the bare event name (e.g. `user.entered_room`, NOT
 *     `bureau.user.entered_room`) with `source: 'bureau'` per the Wave 0.4
 *     drift guard rules (scripts/check-bolt-catalog.mjs).
 *   - Is fire-and-forget — publishBoltEvent swallows all errors, so a Bolt
 *     outage never breaks the originating Bureau request.
 *   - Takes an explicit `orgId` first (matches the publishBoltEvent signature
 *     order) followed by the acting `userId` (becomes actor_id / actor.*).
 *
 * The event-catalog registration lives in
 * apps/bolt-api/src/services/event-catalog.ts (`bureauEvents` array).
 *
 * ─── TODO — wire-up map for Agents A and B ──────────────────────────────
 * Once Agent A (floors/rooms/offices/presence/livekit) and Agent B
 * (bookings/knocks/summons/settings) land their route files, they should
 * import and call these helpers from the indicated locations. Until then
 * these wrappers exist but stay unreferenced inside this package.
 *
 *   • emitUserEnteredRoom   — presence.routes.ts (POST /v1/presence/room),
 *                             livekit.routes.ts (after a successful join)
 *   • emitUserLeftRoom      — presence.routes.ts (DELETE/heartbeat-expiry),
 *                             livekit.routes.ts (on participant disconnect)
 *   • emitStatusChanged     — presence.routes.ts (PATCH /v1/presence/status)
 *                             — also fire from settings.routes.ts when DND
 *                             toggles flip a user's status.
 *   • emitKnockRequested    — knocks.routes.ts (POST /v1/knocks)
 *   • emitKnockResolved     — knocks.routes.ts
 *                             (PATCH /v1/knocks/:id, plus the timeout sweeper)
 *   • emitRoomBooked        — bookings.routes.ts (POST /v1/bookings, and the
 *                             Book→Bureau sync endpoint)
 *   • emitRoomLocked        — rooms.routes.ts (PATCH privacy override),
 *                             bookings.routes.ts (when access='locked'),
 *                             settings.routes.ts (DND auto-lock)
 *   • emitSummonIssued      — summons.routes.ts (POST /v1/summons)
 *
 * Internal.routes.ts itself emits no events — it is a read-only visibility
 * preflight that returns { allowed } to peer services.
 */

import { publishBoltEvent } from '@bigbluebam/shared';

const SOURCE = 'bureau';

// publishBoltEvent expects a generic Record<string, unknown> payload.
// Our typed payload shapes are structurally compatible but TS won't widen
// nominal interfaces to an index-signature type without help. A single cast
// helper keeps the wrappers tidy and concentrates the unsafe coercion.
function asPayload(p: object): Record<string, unknown> {
  return p as unknown as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// Presence
// ─────────────────────────────────────────────────────────────────────

export interface UserEnteredRoomPayload {
  room: { id: string; name: string; type: string; floor_id: string };
  livekit_room: string;
  user: { id: string; name?: string | null };
  actor: { id: string; name?: string | null };
  org: { id: string };
}

/**
 * Fired when a user enters a Bureau room. Call after presence row is
 * written AND the LiveKit room name is known (so frontend WS listeners
 * can pre-join the audio room without an extra round trip).
 */
export function emitUserEnteredRoom(
  orgId: string,
  userId: string,
  payload: UserEnteredRoomPayload,
): Promise<void> {
  return publishBoltEvent('user.entered_room', SOURCE, asPayload(payload), orgId, userId);
}

export interface UserLeftRoomPayload {
  room: { id: string; name?: string | null; floor_id?: string | null };
  user: { id: string; name?: string | null };
  session_duration_ms?: number;
  actor: { id: string };
  org: { id: string };
}

/**
 * Fired when a user leaves a Bureau room. Also fire from the heartbeat
 * sweeper when a session expires without an explicit DELETE.
 */
export function emitUserLeftRoom(
  orgId: string,
  userId: string,
  payload: UserLeftRoomPayload,
): Promise<void> {
  return publishBoltEvent('user.left_room', SOURCE, asPayload(payload), orgId, userId);
}

export interface StatusChangedPayload {
  user: { id: string };
  status: { previous?: string | null; current: string };
  actor: { id: string };
  org: { id: string };
}

/** Fired when a user changes their presence status (available/busy/dnd/...). */
export function emitStatusChanged(
  orgId: string,
  userId: string,
  payload: StatusChangedPayload,
): Promise<void> {
  return publishBoltEvent('status.changed', SOURCE, asPayload(payload), orgId, userId);
}

// ─────────────────────────────────────────────────────────────────────
// Knocks
// ─────────────────────────────────────────────────────────────────────

export interface KnockRequestedPayload {
  knock: { id: string };
  room: { id: string; name?: string | null };
  visitor: { id: string; name?: string | null };
  owner: { id: string };
  message?: string | null;
  actor: { id: string };
  org: { id: string };
}

/** Fired when a visitor knocks on a closed office door. */
export function emitKnockRequested(
  orgId: string,
  userId: string,
  payload: KnockRequestedPayload,
): Promise<void> {
  return publishBoltEvent('knock.requested', SOURCE, asPayload(payload), orgId, userId);
}

export type KnockResolution =
  | 'admitted'
  | 'declined'
  | 'deferred'
  | 'timed_out'
  | 'dnd_blocked';

export interface KnockResolvedPayload {
  knock: { id: string; status: KnockResolution };
  room: { id: string };
  visitor: { id: string };
  owner: { id: string };
  resolved_at: string;
  actor: { id: string };
  org: { id: string };
}

/** Fired when a knock is resolved (admit/decline/timeout/etc.). */
export function emitKnockResolved(
  orgId: string,
  userId: string,
  payload: KnockResolvedPayload,
): Promise<void> {
  return publishBoltEvent('knock.resolved', SOURCE, asPayload(payload), orgId, userId);
}

// ─────────────────────────────────────────────────────────────────────
// Bookings + room state
// ─────────────────────────────────────────────────────────────────────

export interface RoomBookedPayload {
  booking: {
    id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    access: 'open' | 'locked';
  };
  room: { id: string; name?: string | null };
  book_event_id: string;
  organizer: { id: string };
  actor: { id: string };
  org: { id: string };
}

/** Fired when a bookable Bureau room is reserved for a window. */
export function emitRoomBooked(
  orgId: string,
  userId: string,
  payload: RoomBookedPayload,
): Promise<void> {
  return publishBoltEvent('room.booked', SOURCE, asPayload(payload), orgId, userId);
}

export interface RoomLockedPayload {
  room: { id: string; name?: string | null };
  privacy: { previous?: string | null; current: string };
  reason?: string | null;
  actor: { id: string };
  org: { id: string };
}

/**
 * Fired when a room's privacy override flips it locked / private.
 * Sources: manual override, booking with access='locked', DND auto-lock.
 */
export function emitRoomLocked(
  orgId: string,
  userId: string,
  payload: RoomLockedPayload,
): Promise<void> {
  return publishBoltEvent('room.locked', SOURCE, asPayload(payload), orgId, userId);
}

// ─────────────────────────────────────────────────────────────────────
// Summons
// ─────────────────────────────────────────────────────────────────────

export interface SummonIssuedPayload {
  summon: { id: string };
  summoner: { id: string };
  from_room_id?: string | null;
  target_url: string;
  target_app: string;
  target_label?: string | null;
  livekit_room_hint?: string | null;
  recipient_count: number;
  actor: { id: string };
  org: { id: string };
}

/** Fired when a summoner issues a "bring everyone here" teleport. */
export function emitSummonIssued(
  orgId: string,
  userId: string,
  payload: SummonIssuedPayload,
): Promise<void> {
  return publishBoltEvent('summon.issued', SOURCE, asPayload(payload), orgId, userId);
}
