/**
 * Bureau Redis presence service (Agent A, workstream 3).
 *
 * Pure functions over an ioredis client implementing the §7 schema:
 *
 *   bureau:sess:{sessionId}         HASH  per active session (TTL 35s)
 *   bureau:user:{userId}:sessions   SET   sessionIds (device fan-in)
 *   bureau:room:{roomId}:occupants  SET   userIds currently in the room
 *   bureau:room:{roomId}:state      HASH  { privacy, lockedBy }
 *   bureau:floor:{floorId}:index    HASH  userId -> roomId
 *
 * Every function takes the Redis client as its first parameter so callers
 * can pass `fastify.redis` from a route handler or a mock client from a
 * unit test. None of these helpers know about Fastify, sessions, or auth;
 * they are a thin, testable shell over the key schema.
 *
 * The §7 spec says a user's *set membership* in
 * `bureau:room:{roomId}:occupants` is keyed by `userId`, not `sessionId`,
 * because the floor view collapses a user's multiple devices into one
 * avatar. We follow that convention here. As a consequence, a user with
 * two open sessions in the same room only gets one set entry; reaping one
 * of those sessions must NOT remove them from the room until the last
 * session in that room is gone. The reaper / endSession logic should
 * check `getUserSessions` and the per-session `roomId` field before
 * pulling a userId out of `occupants`. (TODO for the reaper agent.) For
 * the v1 path the workstream-3 WS hub will only ever maintain one active
 * session per (user, room) pair, so the simpler unconditional remove
 * below is correct under that assumption.
 */

import type Redis from 'ioredis';

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Session HASH TTL in seconds. Heartbeats refresh this every 15s (§7). */
export const SESSION_TTL_SECONDS = 35;

// ─────────────────────────────────────────────────────────────────────
// Key builders
// ─────────────────────────────────────────────────────────────────────

export const keys = {
  session: (sessionId: string) => `bureau:sess:${sessionId}`,
  userSessions: (userId: string) => `bureau:user:${userId}:sessions`,
  roomOccupants: (roomId: string) => `bureau:room:${roomId}:occupants`,
  roomState: (roomId: string) => `bureau:room:${roomId}:state`,
  floorIndex: (floorId: string) => `bureau:floor:${floorId}:index`,
  /** SCAN match pattern for live-session readers (presence-here). */
  sessionScanPattern: () => 'bureau:sess:*',
  /**
   * Durable per-session index HASH (sessionId → JSON snapshot, no TTL).
   * Why it exists: the per-session `bureau:sess:{id}` HASH carries a 35s
   * TTL, and Redis EVICTS the key the moment it lapses — by the time the
   * reaper notices, the userId/roomId/floorId needed to clean up the
   * room-occupants SET, floor index, and user-sessions SET are gone, so a
   * crashed client used to ghost in its room forever. The index keeps a
   * tiny TTL-less copy of exactly those fields so the reaper can finish
   * the job. Deliberately NOT under the `bureau:sess:` prefix so the
   * presence-here SCAN never picks it up.
   */
  sessionIndex: () => 'bureau:presence:index',
} as const;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** Allowed presence statuses (§8 set_status enum). */
export type PresenceStatus =
  | 'available'
  | 'busy'
  | 'dnd'
  | 'focus'
  | 'away'
  | 'in_meeting';

/** Allowed device kinds for a session (mirrors bureau_presence_sessions.device). */
export type SessionDevice = 'web' | 'pip' | 'desktop' | 'agent';

/** Room privacy values held in the live `bureau:room:{id}:state` HASH. */
export type RoomPrivacy = 'open' | 'knock' | 'private';

/**
 * Parsed session HASH. Strings only because that's what Redis stores; the
 * route layer / SDK is responsible for parsing `isAgent` into a boolean
 * and `lastBeat` into a number when it needs them.
 */
export interface SessionRecord {
  sessionId: string;
  userId: string;
  isAgent: boolean;
  orgId: string;
  floorId: string | null;
  roomId: string | null;
  status: PresenceStatus;
  statusText: string | null;
  emoji: string | null;
  locationUrl: string | null;
  locationApp: string | null;
  locationLabel: string | null;
  device: SessionDevice;
  lastBeat: number;
}

export interface CreateSessionArgs {
  sessionId: string;
  userId: string;
  isAgent: boolean;
  orgId: string;
  /** Optional initial floor — when set, the user lands on this floor but no room. */
  floorId?: string | null;
  device: SessionDevice;
  /** Optional initial status; defaults to 'available'. */
  status?: PresenceStatus;
}

export interface EndSessionResult {
  userId: string;
  roomId: string | null;
  floorId: string | null;
}

export interface EnterRoomResult {
  previousRoomId: string | null;
  floorId: string | null;
}

/**
 * The TTL-less snapshot kept in the `bureau:presence:index` HASH per
 * session. Mirrored (by hand — keep in sync) in
 * apps/worker/src/services/bureau-presence-cleanup.ts, which consumes it
 * when the session HASH has already been evicted.
 */
export interface SessionIndexEntry {
  userId: string;
  orgId: string;
  floorId: string | null;
  roomId: string | null;
  device: SessionDevice;
}

function indexEntryJson(entry: SessionIndexEntry): string {
  return JSON.stringify(entry);
}

// ─────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Convert a HGETALL Record into a typed SessionRecord. Returns null when the
 * HASH is empty (i.e. the key has expired or never existed).
 */
function parseSession(
  sessionId: string,
  hash: Record<string, string>,
): SessionRecord | null {
  if (!hash || Object.keys(hash).length === 0) return null;

  const userId = hash.userId;
  if (!userId) return null;

  return {
    sessionId,
    userId,
    isAgent: hash.isAgent === '1' || hash.isAgent === 'true',
    orgId: hash.orgId ?? '',
    floorId: hash.floorId && hash.floorId.length > 0 ? hash.floorId : null,
    roomId: hash.roomId && hash.roomId.length > 0 ? hash.roomId : null,
    status: (hash.status as PresenceStatus) ?? 'available',
    statusText: hash.statusText && hash.statusText.length > 0 ? hash.statusText : null,
    emoji: hash.emoji && hash.emoji.length > 0 ? hash.emoji : null,
    locationUrl: hash.locationUrl && hash.locationUrl.length > 0 ? hash.locationUrl : null,
    locationApp: hash.locationApp && hash.locationApp.length > 0 ? hash.locationApp : null,
    locationLabel:
      hash.locationLabel && hash.locationLabel.length > 0 ? hash.locationLabel : null,
    device: (hash.device as SessionDevice) ?? 'web',
    lastBeat: hash.lastBeat ? Number(hash.lastBeat) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────

/**
 * Open a new presence session. Writes the session HASH, joins it to the
 * user's session SET, and stamps a 35s TTL so a missed heartbeat causes
 * the reaper to pick it up (§13). The session has no roomId yet — that's
 * established by a follow-up `enterRoom`.
 */
export async function createSession(
  redis: Redis,
  args: CreateSessionArgs,
): Promise<void> {
  const {
    sessionId,
    userId,
    isAgent,
    orgId,
    floorId = null,
    device,
    status = 'available',
  } = args;

  const sessionKey = keys.session(sessionId);
  const userKey = keys.userSessions(userId);
  const now = Date.now();

  const pipeline = redis.pipeline();
  pipeline.hset(sessionKey, {
    userId,
    isAgent: isAgent ? '1' : '0',
    orgId,
    floorId: floorId ?? '',
    roomId: '',
    status,
    statusText: '',
    emoji: '',
    locationUrl: '',
    locationApp: '',
    locationLabel: '',
    device,
    lastBeat: String(now),
  });
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  pipeline.sadd(userKey, sessionId);
  // Durable reaper index — see keys.sessionIndex for why this exists.
  pipeline.hset(
    keys.sessionIndex(),
    sessionId,
    indexEntryJson({ userId, orgId, floorId, roomId: null, device }),
  );
  await pipeline.exec();
}

/**
 * Refresh the 35s TTL on a session HASH and bump `lastBeat`. Returns
 * `true` when the session existed (i.e. the heartbeat was honored) and
 * `false` when it had already lapsed — the WS handler can use that signal
 * to close the socket and tell the client to reconnect.
 */
export async function heartbeat(redis: Redis, sessionId: string): Promise<boolean> {
  const sessionKey = keys.session(sessionId);
  const exists = await redis.exists(sessionKey);
  if (!exists) return false;

  const pipeline = redis.pipeline();
  pipeline.hset(sessionKey, 'lastBeat', String(Date.now()));
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  await pipeline.exec();
  return true;
}

/**
 * Tear down a session. Reads the session first so we know which room and
 * floor to clean up, then runs every cleanup write in a single pipeline.
 * Returns the `{ userId, roomId, floorId }` the caller needs to emit
 * `user.left_room` / `presence_delta` events.
 *
 * Returns null when the session HASH was already gone (idempotent).
 */
export async function endSession(
  redis: Redis,
  sessionId: string,
): Promise<EndSessionResult | null> {
  const sessionKey = keys.session(sessionId);
  const hash = await redis.hgetall(sessionKey);
  const session = parseSession(sessionId, hash);
  if (!session) return null;

  const pipeline = redis.pipeline();
  if (session.roomId) {
    pipeline.srem(keys.roomOccupants(session.roomId), session.userId);
  }
  if (session.floorId) {
    pipeline.hdel(keys.floorIndex(session.floorId), session.userId);
  }
  pipeline.srem(keys.userSessions(session.userId), sessionId);
  pipeline.del(sessionKey);
  pipeline.hdel(keys.sessionIndex(), sessionId);
  await pipeline.exec();

  return {
    userId: session.userId,
    roomId: session.roomId,
    floorId: session.floorId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Room movement
// ─────────────────────────────────────────────────────────────────────

/**
 * Move the session's user into a room. Looks up the session to learn the
 * previous roomId and the current floorId, then atomically swaps the
 * user out of the old occupants set (if any) into the new one and updates
 * the floor index. The session HASH's `roomId` field is updated and the
 * TTL is refreshed (since this is also a liveness signal).
 *
 * Throws if the session does not exist — the caller should have just
 * created it.
 */
export async function enterRoom(
  redis: Redis,
  sessionId: string,
  roomId: string,
  /**
   * The floor the room actually belongs to (bureau_rooms.floor_id). The WS
   * hub passes this because a session can enter a room without ever having
   * subscribed to its floor (e.g. the SDK's enterRoom action from another
   * SPA), in which case the session's own floorId is empty or stale. When
   * omitted, the session's current floorId is used as before.
   */
  explicitFloorId?: string,
): Promise<EnterRoomResult> {
  const sessionKey = keys.session(sessionId);
  const hash = await redis.hgetall(sessionKey);
  const session = parseSession(sessionId, hash);
  if (!session) {
    throw new Error(`enterRoom: session ${sessionId} does not exist or has lapsed`);
  }

  const previousRoomId = session.roomId;
  const floorId = explicitFloorId ?? session.floorId;

  const pipeline = redis.pipeline();
  if (previousRoomId && previousRoomId !== roomId) {
    pipeline.srem(keys.roomOccupants(previousRoomId), session.userId);
  }
  pipeline.sadd(keys.roomOccupants(roomId), session.userId);
  pipeline.hset(sessionKey, 'roomId', roomId, 'lastBeat', String(Date.now()));
  if (explicitFloorId && explicitFloorId !== session.floorId) {
    pipeline.hset(sessionKey, 'floorId', explicitFloorId);
    // The user can't be on two floors — drop the stale index entry.
    if (session.floorId) {
      pipeline.hdel(keys.floorIndex(session.floorId), session.userId);
    }
  }
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  if (floorId) {
    pipeline.hset(keys.floorIndex(floorId), session.userId, roomId);
  }
  pipeline.hset(
    keys.sessionIndex(),
    sessionId,
    indexEntryJson({
      userId: session.userId,
      orgId: session.orgId,
      floorId,
      roomId,
      device: session.device,
    }),
  );
  await pipeline.exec();

  return { previousRoomId, floorId };
}

/**
 * Leave the current room without entering another one. Mirrors
 * `enterRoom` but clears `roomId` on the session and removes the user
 * from the floor index. Returns the room the user came from (or null
 * if they weren't in one).
 */
export async function leaveRoom(
  redis: Redis,
  sessionId: string,
): Promise<EnterRoomResult> {
  const sessionKey = keys.session(sessionId);
  const hash = await redis.hgetall(sessionKey);
  const session = parseSession(sessionId, hash);
  if (!session) {
    throw new Error(`leaveRoom: session ${sessionId} does not exist or has lapsed`);
  }

  const previousRoomId = session.roomId;
  const floorId = session.floorId;

  const pipeline = redis.pipeline();
  if (previousRoomId) {
    pipeline.srem(keys.roomOccupants(previousRoomId), session.userId);
  }
  pipeline.hset(sessionKey, 'roomId', '', 'lastBeat', String(Date.now()));
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  if (floorId) {
    pipeline.hdel(keys.floorIndex(floorId), session.userId);
  }
  pipeline.hset(
    keys.sessionIndex(),
    sessionId,
    indexEntryJson({
      userId: session.userId,
      orgId: session.orgId,
      floorId,
      roomId: null,
      device: session.device,
    }),
  );
  await pipeline.exec();

  return { previousRoomId, floorId };
}

/**
 * Pin the session to a floor without entering a room (the WS hub's
 * subscribe_floor path). Refreshes the TTL — subscribing is a liveness
 * signal.
 */
export async function setFloor(
  redis: Redis,
  sessionId: string,
  floorId: string,
): Promise<void> {
  const sessionKey = keys.session(sessionId);
  const pipeline = redis.pipeline();
  pipeline.hset(sessionKey, 'floorId', floorId, 'lastBeat', String(Date.now()));
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  await pipeline.exec();

  // Mirror the floor onto the reaper index so a crash on this floor gets
  // its `presence_delta` cleanup broadcast on the right channel. Read-
  // modify-write is safe: a single socket owns its sessionId.
  try {
    const raw = await redis.hget(keys.sessionIndex(), sessionId);
    if (raw) {
      const entry = JSON.parse(raw) as SessionIndexEntry;
      if (entry.floorId !== floorId) {
        entry.floorId = floorId;
        await redis.hset(keys.sessionIndex(), sessionId, indexEntryJson(entry));
      }
    }
  } catch {
    // Index update is best-effort; the reaper falls back to the room-less
    // cleanup path when floorId is stale.
  }
}

// ─────────────────────────────────────────────────────────────────────
// Session metadata mutations
// ─────────────────────────────────────────────────────────────────────

/**
 * Update presence status fields on the session HASH. Empty strings are
 * written as "" so callers explicitly clearing statusText/emoji round
 * through without a separate HDEL. Refreshes the TTL since a status
 * change is also a liveness signal.
 */
export async function setStatus(
  redis: Redis,
  sessionId: string,
  status: PresenceStatus,
  statusText?: string | null,
  emoji?: string | null,
): Promise<void> {
  const sessionKey = keys.session(sessionId);

  const pipeline = redis.pipeline();
  pipeline.hset(
    sessionKey,
    'status',
    status,
    'statusText',
    statusText ?? '',
    'emoji',
    emoji ?? '',
    'lastBeat',
    String(Date.now()),
  );
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  await pipeline.exec();
}

/**
 * Update the live SDK-reported location on the session HASH. Refreshes
 * the TTL (the SDK ticks this at least once per heartbeat window so it
 * doubles as a heartbeat signal in practice).
 */
export async function updateLocation(
  redis: Redis,
  sessionId: string,
  locationUrl: string | null,
  locationApp: string | null,
  locationLabel: string | null,
): Promise<void> {
  const sessionKey = keys.session(sessionId);

  const pipeline = redis.pipeline();
  pipeline.hset(
    sessionKey,
    'locationUrl',
    locationUrl ?? '',
    'locationApp',
    locationApp ?? '',
    'locationLabel',
    locationLabel ?? '',
    'lastBeat',
    String(Date.now()),
  );
  pipeline.expire(sessionKey, SESSION_TTL_SECONDS);
  await pipeline.exec();
}

// ─────────────────────────────────────────────────────────────────────
// Room state (door / lock)
// ─────────────────────────────────────────────────────────────────────

/**
 * Write the live door state for a room. Used by office-door overrides
 * and the DND auto-lock path. `lockedBy` is recorded so the UI can
 * attribute the lock and the unlocker can be enforced.
 *
 * `bureau:room:{roomId}:state` does NOT carry a TTL — it persists for
 * the lifetime of the override and is cleared explicitly when the room
 * is unlocked / reset to defaults.
 */
export async function setDoor(
  redis: Redis,
  roomId: string,
  privacy: RoomPrivacy,
  lockedBy?: string | null,
): Promise<void> {
  const stateKey = keys.roomState(roomId);
  await redis.hset(
    stateKey,
    'privacy',
    privacy,
    'lockedBy',
    lockedBy ?? '',
  );
}

/**
 * Convenience: lock a room to `private` and stamp the locker. Equivalent
 * to `setDoor(redis, roomId, 'private', lockedBy)` but reads better at
 * call sites that care about the "lock" verb.
 */
export async function lockRoom(
  redis: Redis,
  roomId: string,
  lockedBy: string,
): Promise<void> {
  return setDoor(redis, roomId, 'private', lockedBy);
}

export interface DoorState {
  privacy: RoomPrivacy;
  lockedBy: string | null;
}

/**
 * Read the live door-state override for a room. Returns null when no
 * override has ever been written (the room is on its DB
 * `privacy_default`). Callers that gate entry (WS enter_room, the LiveKit
 * token mints, the internal can-join-room preflight) MUST overlay this on
 * top of `bureau_rooms.privacy_default` — otherwise `lock_room` /
 * `set_door` are display-only and a "locked" room blocks nobody.
 */
export async function getDoorState(
  redis: Redis,
  roomId: string,
): Promise<DoorState | null> {
  const state = await redis.hgetall(keys.roomState(roomId));
  if (!state || Object.keys(state).length === 0) return null;
  const privacy = state.privacy;
  if (privacy !== 'open' && privacy !== 'knock' && privacy !== 'private') {
    return null;
  }
  return {
    privacy,
    lockedBy: state.lockedBy && state.lockedBy.length > 0 ? state.lockedBy : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────

/** Return the userIds currently inside a room. Empty array if none. */
export async function getRoomOccupants(
  redis: Redis,
  roomId: string,
): Promise<string[]> {
  return redis.smembers(keys.roomOccupants(roomId));
}

/**
 * Read the floor occupancy index. Returns a Map keyed by userId -> roomId
 * for fast initial paint of a floor on `subscribe_floor`.
 */
export async function getFloorIndex(
  redis: Redis,
  floorId: string,
): Promise<Map<string, string>> {
  const hash = await redis.hgetall(keys.floorIndex(floorId));
  const map = new Map<string, string>();
  for (const [userId, roomId] of Object.entries(hash)) {
    if (roomId && roomId.length > 0) {
      map.set(userId, roomId);
    }
  }
  return map;
}

/**
 * Build a full floor snapshot for `presence_snapshot`: the userId→roomId
 * occupancy map plus the live door-state HASH for every represented room.
 * Lifted verbatim from the WS hub's inline presence layer (D-10).
 */
export async function snapshotFloor(
  redis: Redis,
  floorId: string,
): Promise<{
  occupancy: Record<string, string>;
  roomState: Record<string, Record<string, string>>;
}> {
  const occupancy = await redis.hgetall(keys.floorIndex(floorId));
  const roomState: Record<string, Record<string, string>> = {};
  const uniqueRooms = new Set(Object.values(occupancy));
  for (const roomId of uniqueRooms) {
    if (!roomId) continue;
    const state = await redis.hgetall(keys.roomState(roomId));
    if (state && Object.keys(state).length > 0) {
      roomState[roomId] = state;
    }
  }
  return { occupancy, roomState };
}

/** Read and parse a session HASH. Returns null if it does not exist. */
export async function getSession(
  redis: Redis,
  sessionId: string,
): Promise<SessionRecord | null> {
  const hash = await redis.hgetall(keys.session(sessionId));
  return parseSession(sessionId, hash);
}

/** Return the set of sessionIds for a user (one per device). */
export async function getUserSessions(
  redis: Redis,
  userId: string,
): Promise<string[]> {
  return redis.smembers(keys.userSessions(userId));
}

// NOTE: an earlier `listLapsedSessions` SCAN helper lived here. It was
// removed in the bureau troubleshooting pass (2026-06-10): it could only
// ever surface sessions whose `bureau:sess:{id}` key Redis had ALREADY
// evicted (TTL lapse deletes the key), at which point the session data
// needed for cleanup was unrecoverable. The reaper now walks the TTL-less
// `bureau:presence:index` HASH instead — see keys.sessionIndex and
// apps/worker/src/jobs/bureau-presence-reap.ts.
