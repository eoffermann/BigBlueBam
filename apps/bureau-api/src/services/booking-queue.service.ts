/**
 * Bureau booking-lifecycle queue helper (workstream 4 — Agent A).
 *
 * Owns the two BullMQ Queue handles bureau-api uses to schedule the
 * `bureau-booking-activate` (fires at starts_at) and
 * `bureau-booking-release` (fires at ends_at) lifecycle jobs.
 *
 * Pattern mirrors `knock-queue.service.ts`:
 *   - dedicated ioredis client with `maxRetriesPerRequest: null` (BullMQ
 *     requirement; sharing the fastify.redis client would clash with
 *     its short command timeout config)
 *   - lazy-init singletons so importing the module is side-effect-free
 *   - fire-and-forget enqueues: a queue hiccup must never fail the
 *     user-facing booking POST. Worst case we miss the privacy override
 *     for one booking, which is recoverable manually and self-heals on
 *     the next booking's activate pass.
 *
 * jobId convention:
 *   `activate-{bookingId}` and `release-{bookingId}` so a re-enqueue
 *   from PATCH (window changed) dedups against the prior job. BullMQ
 *   rejects duplicates by jobId; that is by design here — the route
 *   handler removes the old job first via removeJobById before
 *   re-adding, so a window change always produces a single live job
 *   per phase.
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../env.js';

/** Match the consumer-side queue names in apps/worker/src/worker.ts. */
export const BOOKING_ACTIVATE_QUEUE = 'bureau-booking-activate';
export const BOOKING_RELEASE_QUEUE = 'bureau-booking-release';

let activateQueue: Queue | null = null;
let releaseQueue: Queue | null = null;
let connection: Redis | null = null;

function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getActivateQueue(): Queue {
  if (!activateQueue) {
    activateQueue = new Queue(BOOKING_ACTIVATE_QUEUE, {
      connection: getConnection(),
    });
  }
  return activateQueue;
}

function getReleaseQueue(): Queue {
  if (!releaseQueue) {
    releaseQueue = new Queue(BOOKING_RELEASE_QUEUE, {
      connection: getConnection(),
    });
  }
  return releaseQueue;
}

// ─────────────────────────────────────────────────────────────────────
// Job data shapes (mirror the worker side; keep in sync).
// ─────────────────────────────────────────────────────────────────────

export interface BookingActivateJobData {
  bookingId: string;
  roomId: string;
  orgId: string;
  organizerId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  access: 'open' | 'locked';
  bookEventId: string;
}

export interface BookingReleaseJobData {
  bookingId: string;
  roomId: string;
  orgId: string;
  endsAt: string;
}

function activateJobId(bookingId: string): string {
  return `activate-${bookingId}`;
}

function releaseJobId(bookingId: string): string {
  return `release-${bookingId}`;
}

/**
 * Enqueue both lifecycle jobs for a brand-new booking. Delays are
 * computed from now → startsAt / endsAt. A booking whose window has
 * already elapsed at create time silently skips enqueue for any phase
 * already in the past — there is nothing useful to do.
 *
 * Best-effort: errors are logged and swallowed so the originating
 * booking POST is not blocked by Redis hiccups.
 */
export async function scheduleBookingLifecycle(
  activate: BookingActivateJobData,
  release: BookingReleaseJobData,
): Promise<void> {
  const now = Date.now();
  const startsAt = Date.parse(activate.startsAt);
  const endsAt = Date.parse(release.endsAt);

  if (Number.isFinite(startsAt) && startsAt > now) {
    try {
      await getActivateQueue().add('activate', activate, {
        jobId: activateJobId(activate.bookingId),
        delay: startsAt - now,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    } catch (err) {
      console.error(
        `[bureau-booking-queue] failed to enqueue activate for booking ${activate.bookingId}:`,
        err,
      );
    }
  }

  if (Number.isFinite(endsAt) && endsAt > now) {
    try {
      await getReleaseQueue().add('release', release, {
        jobId: releaseJobId(release.bookingId),
        delay: endsAt - now,
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    } catch (err) {
      console.error(
        `[bureau-booking-queue] failed to enqueue release for booking ${release.bookingId}:`,
        err,
      );
    }
  }
}

/**
 * Re-schedule lifecycle jobs after a booking window changed. Removes
 * any existing delayed jobs (matched by jobId) then re-adds with the
 * new delays. BullMQ's removeJobById is a no-op when the job is gone
 * or already moved out of the delayed set, so this is safe to call
 * for PATCHes that did not actually move the window.
 */
export async function rescheduleBookingLifecycle(
  activate: BookingActivateJobData,
  release: BookingReleaseJobData,
): Promise<void> {
  try {
    await getActivateQueue().remove(activateJobId(activate.bookingId));
  } catch {
    // ignore; the add will fail loudly if the duplicate is still there.
  }
  try {
    await getReleaseQueue().remove(releaseJobId(release.bookingId));
  } catch {
    // ignore
  }
  await scheduleBookingLifecycle(activate, release);
}

/**
 * Cancel both lifecycle jobs for a booking. Used when DELETE
 * /bookings/:id soft-cancels the row — the worker would correctly
 * no-op on cancelled rows anyway, but removing the delayed jobs
 * keeps the queue clean and avoids a needless wakeup at window time.
 */
export async function cancelBookingLifecycle(
  bookingId: string,
): Promise<void> {
  try {
    await getActivateQueue().remove(activateJobId(bookingId));
  } catch (err) {
    console.error(
      `[bureau-booking-queue] failed to remove activate job for booking ${bookingId}:`,
      err,
    );
  }
  try {
    await getReleaseQueue().remove(releaseJobId(bookingId));
  } catch (err) {
    console.error(
      `[bureau-booking-queue] failed to remove release job for booking ${bookingId}:`,
      err,
    );
  }
}

/** Test-only: tear down the singletons between test runs. */
export async function _resetBookingQueuesForTests(): Promise<void> {
  if (activateQueue) {
    await activateQueue.close();
    activateQueue = null;
  }
  if (releaseQueue) {
    await releaseQueue.close();
    releaseQueue = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
