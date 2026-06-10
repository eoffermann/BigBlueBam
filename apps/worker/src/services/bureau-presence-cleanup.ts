/**
 * Bureau presence-session cleanup (Agent C, workstream 3 reaper).
 *
 * --------------------------------------------------------------------------
 * DUPLICATED CODE WARNING.
 *
 * The `endBureauSession` function below is a lift-and-shift of the (in-flight)
 * `endSession` implementation in
 *
 *   apps/bureau-api/src/services/presence.service.ts::endSession
 *
 * The bureau-api service is not (yet) a workspace dependency of @bigbluebam/worker
 * — and giving the worker a runtime import on the API package would also drag
 * in Fastify, the auth plugin chain, and the bureau-api Drizzle re-exports.
 * That is too much weight for what is, on this side, a 15-second cron sweep
 * that only needs Redis + a single UPDATE.
 *
 * KEEP IN SYNC: when workstream 2 changes the Redis presence model (key
 * shapes, channel names, payload schemas) or the DB session-row close
 * semantics, mirror the change here in the same commit. The intent is to
 * promote this logic to a shared `@bigbluebam/bureau-presence` package the
 * first time we touch it for a third caller; until then this file is the
 * second copy and bureau-api owns the canonical version.
 *
 * Source: apps/bureau-api/src/services/presence.service.ts (workstream 2)
 * Spec:   docs/plans/bureau-design-document.md §7, §8, §13
 * --------------------------------------------------------------------------
 *
 * Cleanup steps (mirrors §7 Redis model + §8 wire protocol):
 *
 *   1. Read the Redis HASH `bureau:sess:{sessionId}` to recover userId,
 *      orgId, roomId, floorId, device, status. If the hash is already gone
 *      (race with another reaper, explicit DELETE leg) the function is a
 *      no-op.
 *   2. Remove the session from the per-user session set
 *      (`bureau:user:{userId}:sessions`).
 *   3. If, after removing this session, the user has no other live sessions
 *      occupying the same room, SREM the user from
 *      `bureau:room:{roomId}:occupants` and HDEL them from
 *      `bureau:floor:{floorId}:index`. Multi-device (web + pip + desktop)
 *      union semantics from §7.
 *   4. DEL the session hash (in case the TTL was 0 but the key has not yet
 *      been swept by Redis itself).
 *   5. Publish `presence_delta` on `bureau:floor:{floorId}` (room cleared)
 *      and `room_leave` on `bureau:room:{roomId}` per §8 server→client
 *      messages, plus a `bigbluebam:events` mirror so Banter/Bam stay in
 *      sync (§7 channel list).
 *   6. UPDATE the open `bureau_presence_sessions` row for this (user, device)
 *      to set `ended_at = NOW()`. The DB row is keyed by its own UUID, not
 *      by the Redis sessionId, so we close the most-recently-opened row
 *      that matches (user_id, device, ended_at IS NULL).
 *
 * Bolt event emission (`user.left_room`) is left to the CALLER because the
 * reaper job has the full enriched payload + a logger handy, and the
 * cleanup primitive should stay free of HTTP-shaped side effects. The
 * unit tests cover step 1 short-circuit and steps 2-6 happy-path.
 */

import type Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Key helpers (mirror §7 of the design doc — keep in sync with bureau-api)
// ---------------------------------------------------------------------------

const k = {
  sess: (sessionId: string) => `bureau:sess:${sessionId}`,
  userSessions: (userId: string) => `bureau:user:${userId}:sessions`,
  roomOccupants: (roomId: string) => `bureau:room:${roomId}:occupants`,
  floorIndex: (floorId: string) => `bureau:floor:${floorId}:index`,
  floorChannel: (floorId: string) => `bureau:floor:${floorId}`,
  roomChannel: (roomId: string) => `bureau:room:${roomId}`,
  mirrorChannel: () => 'bigbluebam:events',
  /**
   * TTL-less per-session index (sessionId → JSON snapshot). Written by
   * bureau-api's presence.service on createSession/enterRoom/leaveRoom/
   * setFloor; this is what lets the reaper recover userId/roomId/floorId
   * AFTER Redis has evicted the TTL'd `bureau:sess:{id}` hash. Keep in
   * sync with keys.sessionIndex in
   * apps/bureau-api/src/services/presence.service.ts.
   */
  sessIndex: () => 'bureau:presence:index',
} as const;

// ---------------------------------------------------------------------------
// Session shape (mirror §7 HASH fields).
// ---------------------------------------------------------------------------

export interface BureauSessionSnapshot {
  sessionId: string;
  userId: string;
  orgId: string;
  floorId: string | null;
  roomId: string | null;
  device: string;
  status: string | null;
  lastBeat: string | null;
}

export interface BureauCleanupResult {
  /** true if the session existed and we performed cleanup steps. */
  cleaned: boolean;
  /** Snapshot we read (and emitted from), if any. */
  snapshot: BureauSessionSnapshot | null;
  /**
   * true when this was the user's last session in the room, so the room/floor
   * sets actually changed. Useful for the caller's logging and metrics.
   */
  removedFromRoom: boolean;
}

/**
 * Read the session HASH and project it onto a typed snapshot.
 * Returns null if the key is absent (already swept).
 */
async function readSessionSnapshot(
  redis: Redis,
  sessionId: string,
): Promise<BureauSessionSnapshot | null> {
  const raw = await redis.hgetall(k.sess(sessionId));
  if (!raw || Object.keys(raw).length === 0) return null;

  // §7 only mandates userId, orgId, and device; the rest are best-effort.
  if (!raw.userId || !raw.orgId || !raw.device) return null;

  return {
    sessionId,
    userId: raw.userId,
    orgId: raw.orgId,
    floorId: raw.floorId ? raw.floorId : null,
    roomId: raw.roomId ? raw.roomId : null,
    device: raw.device,
    status: raw.status ?? null,
    lastBeat: raw.lastBeat ?? null,
  };
}

/**
 * Fallback snapshot source for sessions whose TTL'd hash Redis has already
 * evicted: the TTL-less `bureau:presence:index` entry written by
 * bureau-api's presence.service. Mirrors SessionIndexEntry over there.
 */
async function readIndexSnapshot(
  redis: Redis,
  sessionId: string,
): Promise<BureauSessionSnapshot | null> {
  const raw = await redis.hget(k.sessIndex(), sessionId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      userId?: unknown;
      orgId?: unknown;
      floorId?: unknown;
      roomId?: unknown;
      device?: unknown;
    };
    if (typeof parsed.userId !== 'string' || typeof parsed.orgId !== 'string') {
      return null;
    }
    return {
      sessionId,
      userId: parsed.userId,
      orgId: parsed.orgId,
      floorId: typeof parsed.floorId === 'string' && parsed.floorId ? parsed.floorId : null,
      roomId: typeof parsed.roomId === 'string' && parsed.roomId ? parsed.roomId : null,
      device: typeof parsed.device === 'string' && parsed.device ? parsed.device : 'web',
      status: null,
      lastBeat: null,
    };
  } catch {
    return null;
  }
}

/**
 * After we have removed sessionId from `bureau:user:{userId}:sessions`,
 * walk the remaining sessions and check whether any of them is still inside
 * the same room. Returns true if no remaining session occupies the room,
 * which is when we are allowed to SREM the user from the room occupant set.
 */
async function isLastSessionInRoom(
  redis: Redis,
  userId: string,
  roomId: string,
): Promise<boolean> {
  const remaining = await redis.smembers(k.userSessions(userId));
  if (remaining.length === 0) return true;

  // hmget across all remaining sessions in one round-trip.
  const pipeline = redis.pipeline();
  for (const otherSessionId of remaining) {
    pipeline.hget(k.sess(otherSessionId), 'roomId');
  }
  const results = await pipeline.exec();
  if (!results) return true;

  for (const [err, value] of results) {
    if (err) continue;
    if (typeof value === 'string' && value === roomId) {
      return false; // another live session is still in this room
    }
  }
  return true;
}

/**
 * Close the most-recently-opened durable session row for this (user, device).
 *
 * The DB row's primary key is its own UUID — there is no Redis-sessionId FK,
 * by design (§7: live state in Redis, durable row only on open/close/room-change).
 * We therefore match on user_id + device + ended_at IS NULL and close the
 * newest such row. If no open row exists (e.g. a heartbeat-only reaper run
 * where the session was never persisted) this is a no-op.
 */
async function closeDurableSessionRow(
  userId: string,
  device: string,
): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE bureau_presence_sessions
    SET ended_at = NOW()
    WHERE id = (
      SELECT id
      FROM bureau_presence_sessions
      WHERE user_id = ${userId}
        AND device = ${device}
        AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    )
  `);
}

/**
 * Publish §8 leave messages on the floor + room channels and mirror to the
 * shared bigbluebam:events channel so other apps (Banter/Bam) stay in sync
 * with the user's last-known presence.
 *
 * Failures are swallowed and logged by the caller; a flaky PubSub must
 * never block durable cleanup.
 */
async function publishLeaveMessages(
  redis: Redis,
  snapshot: BureauSessionSnapshot,
): Promise<void> {
  const pipeline = redis.pipeline();

  if (snapshot.floorId) {
    const delta = JSON.stringify({
      type: 'presence_delta',
      userId: snapshot.userId,
      roomId: null,
      sessionId: snapshot.sessionId,
      reason: 'reaped',
    });
    pipeline.publish(k.floorChannel(snapshot.floorId), delta);
  }

  if (snapshot.roomId) {
    const leave = JSON.stringify({
      type: 'room_leave',
      roomId: snapshot.roomId,
      userId: snapshot.userId,
      sessionId: snapshot.sessionId,
      reason: 'reaped',
    });
    pipeline.publish(k.roomChannel(snapshot.roomId), leave);
  }

  // Bigbluebam:events mirror — Banter/Bam consume user.presence frames from
  // here. Tag with source so cross-app subscribers can filter.
  const mirror = JSON.stringify({
    type: 'user.presence',
    source: 'bureau',
    userId: snapshot.userId,
    orgId: snapshot.orgId,
    roomId: null,
    floorId: snapshot.floorId,
    sessionId: snapshot.sessionId,
    reason: 'reaped',
  });
  pipeline.publish(k.mirrorChannel(), mirror);

  await pipeline.exec();
}

/**
 * Reaper-side endSession — duplicated from
 * apps/bureau-api/src/services/presence.service.ts::endSession.
 *
 * Idempotent: safe to call twice for the same sessionId. Returns
 * `{ cleaned: false, snapshot: null }` when the session is already gone.
 *
 * Steps (see file header for the long-form rationale):
 *   1. Read the session HASH.
 *   2. Remove from `bureau:user:{userId}:sessions`.
 *   3. If last session in the room, clear room occupant set + floor index.
 *   4. DEL the session HASH.
 *   5. Publish leave messages (floor + room + bigbluebam:events).
 *   6. Close the durable bureau_presence_sessions row.
 */
export async function endBureauSession(
  redis: Redis,
  sessionId: string,
): Promise<BureauCleanupResult> {
  // Prefer the live hash; fall back to the TTL-less index entry when Redis
  // has already evicted the hash (the common case for a crashed client —
  // this fallback is what un-ghosts them from room/floor occupancy).
  const snapshot =
    (await readSessionSnapshot(redis, sessionId)) ??
    (await readIndexSnapshot(redis, sessionId));
  if (!snapshot) {
    // Nothing to recover — still drop any stray index entry so the reaper
    // doesn't revisit this id every tick.
    await redis.hdel(k.sessIndex(), sessionId).catch(() => {});
    return { cleaned: false, snapshot: null, removedFromRoom: false };
  }

  // Step 2: drop the session from the per-user set first so the
  // last-session-in-room check below sees an accurate remaining set.
  await redis.srem(k.userSessions(snapshot.userId), sessionId);

  // Step 3: room + floor cleanup, only if this was the last session in the room.
  let removedFromRoom = false;
  if (snapshot.roomId) {
    const isLast = await isLastSessionInRoom(
      redis,
      snapshot.userId,
      snapshot.roomId,
    );
    if (isLast) {
      const pipeline = redis.pipeline();
      pipeline.srem(k.roomOccupants(snapshot.roomId), snapshot.userId);
      if (snapshot.floorId) {
        pipeline.hdel(k.floorIndex(snapshot.floorId), snapshot.userId);
      }
      await pipeline.exec();
      removedFromRoom = true;
    }
  } else if (snapshot.floorId) {
    // No room but still on a floor — clear the floor index entry.
    await redis.hdel(k.floorIndex(snapshot.floorId), snapshot.userId);
  }

  // Step 4: drop the session hash itself + its reaper-index entry.
  await redis.del(k.sess(sessionId));
  await redis.hdel(k.sessIndex(), sessionId);

  // Step 5: §8 leave broadcasts. Pipeline already inside.
  await publishLeaveMessages(redis, snapshot);

  // Step 6: close the durable audit row.
  await closeDurableSessionRow(snapshot.userId, snapshot.device);

  return { cleaned: true, snapshot, removedFromRoom };
}
