/**
 * Bureau pub/sub publishers (Agent A, workstream 3).
 *
 * Thin wrappers around `redis.publish` for each of the §7 channels:
 *
 *   bureau:floor:{floorId}   presence deltas (enter/leave/status/location)
 *   bureau:room:{roomId}     room-scoped events (enter/leave/door/lock)
 *   user:{userId}            targeted events (incoming knock, summon)
 *   bigbluebam:events        mirror of `user.presence` so Banter / Bam stay in sync
 *
 * Each helper takes an ioredis client as its first parameter so it can be
 * unit-tested with a mock client.  Errors are swallowed and logged to
 * `console.error` — a Redis publish failure must never break the
 * originating request (presence is best-effort; a missed publish is
 * recovered on the next heartbeat snapshot).
 *
 * Payloads are typed as `unknown` because the workstream-3 WS hub owns
 * the canonical message shapes (§8); pinning a schema here would force
 * us to round-trip every shape change through this file. The mirror
 * helper IS shape-pinned because its consumers are external (Banter and
 * Bam) — see `mirrorPresenceToShared` below for the assumption it makes
 * about the `user.presence` envelope.
 */

import type Redis from 'ioredis';
import type { PresenceStatus } from './presence.service.js';

// ─────────────────────────────────────────────────────────────────────
// Channel keys
// ─────────────────────────────────────────────────────────────────────

export const channels = {
  floor: (floorId: string) => `bureau:floor:${floorId}`,
  room: (roomId: string) => `bureau:room:${roomId}`,
  user: (userId: string) => `user:${userId}`,
  shared: 'bigbluebam:events',
} as const;

// ─────────────────────────────────────────────────────────────────────
// Internal publish helper
// ─────────────────────────────────────────────────────────────────────

async function publish(
  redis: Redis,
  channel: string,
  payload: unknown,
): Promise<void> {
  try {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await redis.publish(channel, body);
  } catch (err) {
    // Best-effort: never throw out of a publisher. A failed publish is
    // worse than a missed heartbeat but only marginally — the next
    // snapshot will reconcile state on the client.
    console.error(`[bureau-presence-publisher] failed to publish to ${channel}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-floor presence deltas
// ─────────────────────────────────────────────────────────────────────

/**
 * Fan out a presence delta (enter/leave/status/location change) on the
 * floor's pub/sub channel. The WS hub re-broadcasts to every socket
 * subscribed to `floorId`.
 */
export function publishPresenceDelta(
  redis: Redis,
  floorId: string,
  payload: unknown,
): Promise<void> {
  return publish(redis, channels.floor(floorId), payload);
}

// ─────────────────────────────────────────────────────────────────────
// Per-room events
// ─────────────────────────────────────────────────────────────────────

/**
 * Fan out a room-scoped event (enter/leave/door/lock). Used so a client
 * already focused on a single room can listen to one channel instead of
 * filtering the full floor stream.
 */
export function publishRoomEvent(
  redis: Redis,
  roomId: string,
  payload: unknown,
): Promise<void> {
  return publish(redis, channels.room(roomId), payload);
}

// ─────────────────────────────────────────────────────────────────────
// User-targeted events
// ─────────────────────────────────────────────────────────────────────

/**
 * Fan out a targeted event to one user (incoming knock, summon offer,
 * etc.). The WS hub re-broadcasts to every connected device for that
 * user.
 */
export function publishUserTarget(
  redis: Redis,
  userId: string,
  payload: unknown,
): Promise<void> {
  return publish(redis, channels.user(userId), payload);
}

// ─────────────────────────────────────────────────────────────────────
// Cross-app `user.presence` mirror
// ─────────────────────────────────────────────────────────────────────

/**
 * Mirror a Bureau presence change to the shared `bigbluebam:events`
 * channel as a `user.presence` event so Banter and Bam keep working
 * with their existing presence consumers (§7 last bullet).
 *
 * ─── Assumption / open question ──────────────────────────────────────
 * The existing Banter publish path uses an internal `presence.changed`
 * type with a much richer Banter-specific payload (in_call_channel_id,
 * custom_status_text, custom_status_emoji — see
 * apps/banter-api/src/services/presence.service.ts). It is broadcast on
 * `banter:events`, NOT on `bigbluebam:events`. There is no existing
 * publisher writing a canonical `user.presence` envelope on the shared
 * channel in this repo (`bigbluebam:events` appears only as a
 * pub/sub-fanout topic for Bam's WS plugin, and as a type literal in
 * Bam's realtime-event union).
 *
 * Until the Banter/Bam consumers grow an explicit subscription to a
 * Bureau-sourced `user.presence` shape, we emit the documented minimal
 * envelope and let downstream agents widen it:
 *
 *   { type: 'user.presence', user_id, status, source: 'bureau', timestamp }
 *
 * Bureau presence statuses (available, busy, dnd, focus, away,
 * in_meeting) are NOT a strict subset of Banter's (online, idle,
 * in_call, dnd, offline). We pass the Bureau value through verbatim and
 * leave the mapping to the consumer — Banter's existing presence row is
 * still the source of truth for Banter's own UI, and any consumer that
 * needs a normalised four-state value can derive it from `status` plus
 * `source`.
 */
export interface SharedPresenceMirrorEvent {
  type: 'user.presence';
  user_id: string;
  /** 'offline' is emitted on session teardown — not a §8 status, hence the union. */
  status: PresenceStatus | 'offline';
  source: 'bureau';
  timestamp: string;
  org_id?: string;
  room_id?: string | null;
}

export function mirrorPresenceToShared(
  redis: Redis,
  userId: string,
  status: PresenceStatus | 'offline',
  extras: { orgId?: string; roomId?: string | null } = {},
): Promise<void> {
  const event: SharedPresenceMirrorEvent = {
    type: 'user.presence',
    user_id: userId,
    status,
    source: 'bureau',
    timestamp: new Date().toISOString(),
    org_id: extras.orgId,
    room_id: extras.roomId,
  };
  return publish(redis, channels.shared, event);
}
