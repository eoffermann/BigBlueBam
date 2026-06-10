/**
 * Bureau presence reaper job (Agent C, workstream 3).
 *
 * Spec: docs/plans/bureau-design-document.md §13 — `bureau.presence.reap`
 * repeats every 15s.
 *
 * Flow per tick:
 *
 *   1. SCAN `bureau:sess:*` (cursor-paged so a large org never stalls
 *      Redis on a single MATCH).
 *   2. For each session key, PTTL it. If `pttl <= 0` (lapsed) or the
 *      key has gone missing between SCAN and PTTL, treat the session
 *      as expired.
 *   3. Hand the session id to `endBureauSession` in
 *      `services/bureau-presence-cleanup.ts`, which is the lift-and-
 *      shift of bureau-api's presence.service.ts::endSession.
 *   4. Emit a Bolt `user.left_room` event for each cleanly-reaped
 *      session that had an associated room, using the §14 catalog
 *      bare-name convention (`source: 'bureau'`).
 *
 * NOTE on the SCAN race. Redis evicts a key the moment its TTL hits 0;
 * if a key is already gone by the time we PTTL it (return value -2)
 * we cannot recover the userId/orgId/roomId for it, and we silently
 * leave the durable `bureau_presence_sessions` row open. With a 35s
 * TTL and a 15s reap cadence this window is small but non-zero. The
 * design doc accepts this as fine because:
 *
 *   • room + floor occupancy sets are SREM'd by the bureau-api WS
 *     handler on `leave_room` and `disconnect`, so visible state
 *     stays right even when the durable row drifts.
 *   • the §13 `bureau.analytics.rollup` daily job can close any
 *     `ended_at IS NULL` rows older than 24h as a backstop.
 *
 * If this becomes a real problem we will switch the live state to
 * Redis keyspace notifications (`__keyevent@0__:expired`) and react
 * to expirations directly rather than polling.
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

/** SCAN match pattern (mirrors §7). */
const SCAN_MATCH = 'bureau:sess:*';
/** Cursor batch size — high enough to keep tick count low, low enough that
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
 * Walk the keyspace with SCAN and yield candidate session ids whose TTL has
 * lapsed. Yields the bare `sessionId` (the suffix after `bureau:sess:`) so
 * the caller can pass it straight to `endBureauSession`.
 */
async function* findExpiredSessionIds(
  redis: Redis,
  logger: Logger,
): AsyncGenerator<string> {
  let cursor = '0';
  let scanned = 0;

  do {
    let nextCursor: string;
    let keys: string[];
    try {
      const reply = await redis.scan(
        cursor,
        'MATCH',
        SCAN_MATCH,
        'COUNT',
        SCAN_COUNT,
      );
      nextCursor = reply[0];
      keys = reply[1];
    } catch (err) {
      logger.error({ err }, 'bureau.presence.reap: SCAN failed; aborting tick');
      return;
    }

    if (keys.length === 0) {
      cursor = nextCursor;
      continue;
    }

    // PTTL each key in one round-trip.
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.pttl(key);
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

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const entry = results[i];
      if (!entry) continue;
      const [err, pttlValue] = entry;
      if (err) continue;
      const pttl = typeof pttlValue === 'number' ? pttlValue : -2;

      // pttl semantics:
      //   -2 → key does not exist (already evicted, race vs SCAN)
      //   -1 → key exists but has no TTL (should never happen for a
      //        bureau:sess hash, but defensively treat as lapsed)
      //    0 → lapsed
      //   >0 → still alive
      if (pttl > 0) continue;

      scanned += 1;
      const sessionId = key.slice('bureau:sess:'.length);
      if (sessionId) yield sessionId;

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
