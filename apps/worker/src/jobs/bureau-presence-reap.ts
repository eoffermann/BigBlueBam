/**
 * Bureau presence reaper job (Agent C, workstream 3).
 *
 * Spec: docs/plans/bureau-design-document.md §13 — `bureau.presence.reap`
 * repeats every 15s.
 *
 * Flow per tick:
 *
 *   1. HSCAN the TTL-less `bureau:presence:index` HASH (cursor-paged so
 *      a large org never stalls Redis on a single page).
 *   2. For each indexed session, PTTL its live `bureau:sess:{id}` hash.
 *      If the hash is gone (`-2` — Redis evicted it on TTL lapse) or
 *      anomalous (`-1`/`0`), treat the session as expired.
 *   3. Hand the session id to `endBureauSession` in
 *      `services/bureau-presence-cleanup.ts`, which recovers the
 *      userId/orgId/roomId/floorId from the index entry when the hash
 *      is already gone, then cleans the room-occupants SET, floor
 *      index, user-sessions SET, durable row, and the index entry.
 *   4. Emit a Bolt `user.left_room` event for each cleanly-reaped
 *      session that had an associated room, using the §14 catalog
 *      bare-name convention (`source: 'bureau'`).
 *
 * HISTORY (2026-06-10 troubleshooting pass). The original reaper SCANned
 * `bureau:sess:*` and PTTL'd each key — but Redis evicts a key the moment
 * its TTL lapses, so every "expired" candidate it ever found was already
 * unreadable (HGETALL → empty) and `endBureauSession` no-opped. Net
 * effect: the reaper never cleaned anything, and a client that crashed
 * (no WS close on the server) ghosted in its room's occupants SET and
 * floor index FOREVER (those keys carry no TTL). The TTL-less index
 * written by bureau-api's presence.service closes the hole: live-session
 * existence still has 35s-TTL semantics for every reader, while the
 * reaper retains just enough data to clean up after eviction.
 */

import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import {
  endBureauSession,
  type BureauSessionSnapshot,
} from '../services/bureau-presence-cleanup.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL-less session index HASH (sessionId → JSON snapshot), written by
 * bureau-api's presence.service. This — not the `bureau:sess:*` keyspace —
 * is what the reaper walks: a lapsed session's `bureau:sess:{id}` hash is
 * EVICTED by Redis the moment its TTL hits zero, so scanning the keyspace
 * can only ever find sessions whose cleanup data is already gone (the
 * pre-2026-06-10 reaper silently cleaned nothing, leaving crashed clients
 * ghosted in their room/floor occupancy forever). Keep the key name in
 * sync with keys.sessionIndex in
 * apps/bureau-api/src/services/presence.service.ts.
 */
const SESSION_INDEX_KEY = 'bureau:presence:index';
/** HSCAN page size — high enough to keep tick count low, low enough that
 *  one slow batch never blocks Redis for long. */
const SCAN_COUNT = 200;
/** Hard cap on sessions reaped per tick — defensive bound against a Redis
 *  full-of-stale-keys edge case. The next tick (15s later) picks up the rest. */
const MAX_PER_TICK = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BureauPresenceReapJobData {
  /**
   * Optional: scope the sweep to a single SCAN match prefix.
   * Reserved for future use (e.g. shard-local reapers); empty today.
   */
  reserved?: never;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the TTL-less session index with HSCAN and yield candidate session
 * ids whose live `bureau:sess:{id}` hash is gone (evicted on TTL lapse) or
 * anomalous. The index entry retains the userId/orgId/roomId/floorId the
 * cleanup needs, so `endBureauSession` can finish the job even though the
 * hash itself no longer exists.
 */
async function* findExpiredSessionIds(
  redis: Redis,
  logger: Logger,
): AsyncGenerator<string> {
  let cursor = '0';
  let scanned = 0;

  do {
    let nextCursor: string;
    /** HSCAN reply: flat [field1, value1, field2, value2, ...]. */
    let flat: string[];
    try {
      const reply = await redis.hscan(
        SESSION_INDEX_KEY,
        cursor,
        'COUNT',
        SCAN_COUNT,
      );
      nextCursor = reply[0];
      flat = reply[1];
    } catch (err) {
      logger.error({ err }, 'bureau.presence.reap: HSCAN failed; aborting tick');
      return;
    }

    const sessionIds: string[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const sessionId = flat[i];
      if (sessionId) sessionIds.push(sessionId);
    }

    if (sessionIds.length === 0) {
      cursor = nextCursor;
      continue;
    }

    // PTTL each live-session key in one round-trip.
    const pipeline = redis.pipeline();
    for (const sessionId of sessionIds) {
      pipeline.pttl(`bureau:sess:${sessionId}`);
    }
    let results: [Error | null, unknown][] | null;
    try {
      results = await pipeline.exec();
    } catch (err) {
      logger.error({ err }, 'bureau.presence.reap: PTTL pipeline failed; skipping batch');
      cursor = nextCursor;
      continue;
    }
    if (!results) {
      cursor = nextCursor;
      continue;
    }

    for (let i = 0; i < sessionIds.length; i++) {
      const sessionId = sessionIds[i]!;
      const entry = results[i];
      if (!entry) continue;
      const [err, pttlValue] = entry;
      if (err) continue;
      const pttl = typeof pttlValue === 'number' ? pttlValue : -2;

      // pttl semantics:
      //   -2 → hash does not exist (TTL lapsed and Redis evicted it —
      //        the normal crashed-client case; the index entry still has
      //        the cleanup data)
      //   -1 → hash exists but has no TTL (should never happen for a
      //        bureau:sess hash, but defensively treat as lapsed)
      //    0 → lapsed
      //   >0 → still alive (heartbeating); skip
      if (pttl > 0) continue;

      scanned += 1;
      yield sessionId;

      if (scanned >= MAX_PER_TICK) {
        logger.warn(
          { scanned },
          'bureau.presence.reap: hit MAX_PER_TICK cap; remainder picked up next tick',
        );
        return;
      }
    }

    cursor = nextCursor;
  } while (cursor !== '0');
}

/**
 * Emit the §14 `user.left_room` Bolt event for a cleanly-reaped session that
 * had an associated room. Fire-and-forget — `publishBoltEvent` swallows its
 * own errors so a Bolt outage never blocks the sweep.
 */
async function emitLeftRoomEvent(snapshot: BureauSessionSnapshot): Promise<void> {
  if (!snapshot.roomId) return;
  await publishBoltEvent(
    'user.left_room',
    'bureau',
    {
      room: { id: snapshot.roomId, floor_id: snapshot.floorId },
      user: { id: snapshot.userId },
      reason: 'reaped',
      actor: { id: snapshot.userId },
      org: { id: snapshot.orgId },
    },
    snapshot.orgId,
    snapshot.userId,
    'system',
  );
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processBureauPresenceReapJob(
  job: Job<BureauPresenceReapJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const startedAt = Date.now();
  let candidates = 0;
  let reaped = 0;
  let alreadyGone = 0;
  let errors = 0;

  for await (const sessionId of findExpiredSessionIds(redis, logger)) {
    candidates += 1;
    try {
      const result = await endBureauSession(redis, sessionId);
      if (!result.cleaned || !result.snapshot) {
        alreadyGone += 1;
        continue;
      }
      reaped += 1;
      // Bolt event is fire-and-forget; do not let a publish failure derail
      // the next session in the loop.
      await emitLeftRoomEvent(result.snapshot).catch((err) => {
        logger.warn(
          { err, sessionId },
          'bureau.presence.reap: bolt emit failed (swallowed)',
        );
      });
    } catch (err) {
      errors += 1;
      logger.error(
        { err, sessionId },
        'bureau.presence.reap: cleanup failed for session',
      );
    }
  }

  const durationMs = Date.now() - startedAt;
  if (candidates > 0 || errors > 0) {
    logger.info(
      {
        jobId: job.id,
        candidates,
        reaped,
        alreadyGone,
        errors,
        durationMs,
      },
      'bureau.presence.reap: tick complete',
    );
  } else {
    logger.debug(
      { jobId: job.id, durationMs },
      'bureau.presence.reap: tick complete (no candidates)',
    );
  }
}
