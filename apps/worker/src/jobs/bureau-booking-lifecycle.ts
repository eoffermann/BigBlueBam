/**
 * Bureau booking lifecycle jobs (workstream 4 — Agent A).
 *
 * Two delayed BullMQ jobs scheduled at booking-create time and re-scheduled
 * on update:
 *
 *   • bureau.booking.activate  — fires at starts_at
 *       - sets `bureau:room:{roomId}:state` privacy = 'private' so that
 *         walk-in attempts during the meeting are routed through the
 *         knock flow rather than dropping the visitor straight into the
 *         room
 *       - publishes a Bolt `room.booked` event so downstream Bolt rules
 *         (e.g. "if conference room A is booked, post in #planning")
 *         get a clean activation signal
 *       - broadcasts a `door_changed` frame on the bureau:room:{roomId}
 *         channel so live WS clients re-render the door
 *
 *   • bureau.booking.release   — fires at ends_at
 *       - clears the `bureau:room:{roomId}:state` privacy override IF
 *         the current value still matches what activate set (so a manual
 *         post-booking override is not silently undone)
 *       - broadcasts a `door_changed` frame announcing the cleared state
 *
 * Idempotency:
 *   Both jobs are safe to re-run. activate re-sets the same hash field
 *   to the same value (no diff if it was already private from a prior
 *   pass); release only clears when the field still reads as the
 *   activate-set value. Cancelled bookings are filtered out at the top
 *   of each handler so a removed booking does not leak state mutations.
 *
 * Job data:
 *   We carry the bookingId + roomId + orgId + window in the payload so
 *   the worker does not have to re-query the row for the happy path.
 *   The DB lookup at top-of-handler is purely a cancellation gate
 *   (cancelled_at IS NOT NULL → skip the mutation).
 */

import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

// ─────────────────────────────────────────────────────────────────────
// Constants — keep in sync with apps/bureau-api/src/services/presence.service.ts
// ─────────────────────────────────────────────────────────────────────

/** Redis key holding the live door privacy override for a room. */
function roomStateKey(roomId: string): string {
  return `bureau:room:${roomId}:state`;
}

/** Pub/sub channel the bureau-api WS hub fans out room-scoped frames on. */
function roomChannel(roomId: string): string {
  return `bureau:room:${roomId}`;
}

/** Frame helper — mirrors apps/bureau-api/src/routes/ws.routes.ts::frame. */
function frame(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, timestamp: new Date().toISOString() });
}

/**
 * Sentinel value we stash alongside the privacy hash field so the
 * release pass knows the override came from this job (vs. a human
 * setting the door manually after the meeting started). If a human
 * touched the door between activate and release, `lockedBy` will not
 * be 'bureau-booking' anymore and release will leave the override
 * alone.
 */
const ACTIVATION_LOCKED_BY = 'bureau-booking';

// ─────────────────────────────────────────────────────────────────────
// Job data
// ─────────────────────────────────────────────────────────────────────

export interface BureauBookingActivateJobData {
  bookingId: string;
  roomId: string;
  orgId: string;
  organizerId: string;
  /** Booking title — copied into the Bolt payload for downstream rules. */
  title: string;
  /** Window start (ISO-8601). */
  startsAt: string;
  /** Window end (ISO-8601). */
  endsAt: string;
  /** Booking access flag — 'open' (visitors may knock) or 'locked'. */
  access: 'open' | 'locked';
  /** Linked Book event id (may equal bookingId for local-only fallback). */
  bookEventId: string;
}

export interface BureauBookingReleaseJobData {
  bookingId: string;
  roomId: string;
  orgId: string;
  endsAt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface BookingRow {
  id: string;
  cancelled_at: Date | null;
}

/**
 * Re-read the bureau_bookings row so we can short-circuit on cancellation.
 * Returns null on row deletion (which we treat the same as cancellation).
 */
async function loadBooking(bookingId: string): Promise<BookingRow | null> {
  const db = getDb();
  const result = await db.execute(
    sql`SELECT id, cancelled_at FROM bureau_bookings WHERE id = ${bookingId} LIMIT 1`,
  );
  // postgres-js drizzle returns an array of rows directly when used with
  // a SELECT, but the `.execute` helper returns the rows tagged. Defensive
  // shape sniffing keeps the handler resilient if drizzle's shape shifts.
  const rows = Array.isArray(result) ? result : (result as unknown as { rows?: unknown[] }).rows;
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { id: string; cancelled_at: Date | string | null };
  return {
    id: row.id,
    cancelled_at:
      row.cancelled_at === null
        ? null
        : row.cancelled_at instanceof Date
          ? row.cancelled_at
          : new Date(row.cancelled_at),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Activate
// ─────────────────────────────────────────────────────────────────────

/**
 * Apply the door privacy override at window start and announce it.
 *
 * Flow:
 *   1. Skip if the booking was cancelled before the job fired.
 *   2. HSET the room-state HASH with privacy='private', lockedBy='bureau-booking'.
 *   3. Publish a room.booked Bolt event (bare event, source='bureau').
 *   4. Publish a door_changed frame on bureau:room:{roomId} for live WS clients.
 */
export async function processBureauBookingActivateJob(
  job: Job<BureauBookingActivateJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const data = job.data;
  const booking = await loadBooking(data.bookingId);
  if (!booking) {
    logger.info(
      { jobId: job.id, bookingId: data.bookingId },
      'bureau.booking.activate: booking no longer exists; skipping',
    );
    return;
  }
  if (booking.cancelled_at) {
    logger.info(
      { jobId: job.id, bookingId: data.bookingId },
      'bureau.booking.activate: booking cancelled; skipping privacy override',
    );
    return;
  }

  const stateKey = roomStateKey(data.roomId);
  try {
    await redis.hset(stateKey, {
      privacy: 'private',
      lockedBy: ACTIVATION_LOCKED_BY,
    });
  } catch (err) {
    logger.error(
      { err, jobId: job.id, bookingId: data.bookingId, roomId: data.roomId },
      'bureau.booking.activate: redis hset failed',
    );
    throw err;
  }

  // Fire-and-forget Bolt emit; publishBoltEvent swallows its own errors.
  await publishBoltEvent(
    'room.booked',
    'bureau',
    {
      booking: {
        id: data.bookingId,
        title: data.title,
        starts_at: data.startsAt,
        ends_at: data.endsAt,
        access: data.access,
      },
      room: { id: data.roomId },
      book_event_id: data.bookEventId,
      organizer: { id: data.organizerId },
      actor: { id: data.organizerId },
      org: { id: data.orgId },
    },
    data.orgId,
    data.organizerId,
    'system',
  );

  // Broadcast a door_changed frame on the room channel so any WS clients
  // currently focused on the room re-render the door without waiting for
  // the next presence delta.
  try {
    const payload = frame('door_changed', {
      roomId: data.roomId,
      privacy: 'private',
      by: 'bureau-booking',
      bookingId: data.bookingId,
    });
    await redis.publish(roomChannel(data.roomId), payload);
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, roomId: data.roomId },
      'bureau.booking.activate: door_changed publish failed (swallowed)',
    );
  }

  logger.info(
    {
      jobId: job.id,
      bookingId: data.bookingId,
      roomId: data.roomId,
      orgId: data.orgId,
    },
    'bureau.booking.activate: room privacy set to private',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Release
// ─────────────────────────────────────────────────────────────────────

/**
 * Clear the door privacy override at window end and announce it.
 *
 * We only clear the override if `lockedBy` still equals the sentinel
 * we set in activate. If a human has set the door manually since the
 * meeting started, leave it alone — they almost certainly mean it.
 *
 * On cancellation we still want the release pass to run, because a
 * booking that was cancelled while its window was still active should
 * release the room. The booking-row gate is therefore relaxed here:
 * we only return early if the row is GONE (deleted), not on
 * cancelled_at — cancellation needs the release path.
 */
export async function processBureauBookingReleaseJob(
  job: Job<BureauBookingReleaseJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const data = job.data;
  const booking = await loadBooking(data.bookingId);
  if (!booking) {
    // Row was hard-deleted — without it we cannot know whether the
    // override is ours. Be conservative: do not clear, just exit.
    logger.info(
      { jobId: job.id, bookingId: data.bookingId },
      'bureau.booking.release: booking row missing; not touching room state',
    );
    return;
  }

  const stateKey = roomStateKey(data.roomId);
  let lockedBy: string | null = null;
  try {
    lockedBy = await redis.hget(stateKey, 'lockedBy');
  } catch (err) {
    logger.error(
      { err, jobId: job.id, roomId: data.roomId },
      'bureau.booking.release: redis hget failed',
    );
    throw err;
  }

  if (lockedBy !== ACTIVATION_LOCKED_BY) {
    logger.info(
      {
        jobId: job.id,
        bookingId: data.bookingId,
        roomId: data.roomId,
        lockedBy,
      },
      'bureau.booking.release: room privacy is not owned by booking; leaving as-is',
    );
    return;
  }

  // The release wipes BOTH fields together — leaving stray lockedBy=
  // bureau-booking after the privacy field is cleared would confuse the
  // next activate run on a different booking against the same room.
  try {
    await redis.del(stateKey);
  } catch (err) {
    logger.error(
      { err, jobId: job.id, roomId: data.roomId },
      'bureau.booking.release: redis del failed',
    );
    throw err;
  }

  try {
    const payload = frame('door_changed', {
      roomId: data.roomId,
      privacy: 'open',
      by: 'bureau-booking',
      bookingId: data.bookingId,
      released: true,
    });
    await redis.publish(roomChannel(data.roomId), payload);
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, roomId: data.roomId },
      'bureau.booking.release: door_changed publish failed (swallowed)',
    );
  }

  logger.info(
    {
      jobId: job.id,
      bookingId: data.bookingId,
      roomId: data.roomId,
      orgId: data.orgId,
    },
    'bureau.booking.release: room privacy override cleared',
  );
}
