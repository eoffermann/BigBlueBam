/**
 * Bureau in-app notification producer.
 *
 * Bureau-side mirror of the tiny producer in
 * apps/api/src/services/notification-fanout.service.ts: it pushes a job
 * onto the shared 'notifications' BullMQ queue (on env.REDIS_URL). The
 * worker (apps/worker/src/jobs/notification.job.ts) drains that queue and
 * INSERTs a row into the `notifications` table — the same table
 * `list_my_notifications` reads. The job already accepts ANY
 * source_app / category / deep_link, so Bureau just produces the same
 * NotificationJobData shape exported from @bigbluebam/shared.
 *
 * Bureau events that produce a notification:
 *   - knock  (POST /v1/knocks)  → notify the office OWNER
 *   - summon (POST /v1/summon)  → notify each eligible RECIPIENT
 *
 * Delivery is best-effort / fire-and-forget: a Redis hiccup must never
 * fail the originating knock/summon request. `enqueueBureauNotification`
 * therefore swallows all errors (logging them when a logger is supplied)
 * and never throws.
 */

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '../env.js';
import type { NotificationJobData } from '@bigbluebam/shared';

export type { NotificationJobData };

// A minimal logger surface so callers can pass `request.log` / `fastify.log`
// (or nothing) without dragging the full pino type in.
type MiniLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

// ---------------------------------------------------------------------------
// BullMQ notifications queue (producer side)
// ---------------------------------------------------------------------------

let _notificationsQueue: Queue | null = null;

function getNotificationsQueue(): Queue {
  if (!_notificationsQueue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _notificationsQueue = new Queue('notifications', { connection });
  }
  return _notificationsQueue;
}

/**
 * Enqueue a persistent in-app notification for `data.user_id`.
 *
 * Fire-and-forget: never throws. On any failure (queue construction,
 * Redis unreachable, `.add()` rejection) it logs a warning via the
 * supplied logger and resolves. Callers should NOT `await`-then-branch on
 * this — treat it as best-effort.
 */
export async function enqueueBureauNotification(
  data: NotificationJobData,
  logger?: MiniLogger,
): Promise<void> {
  try {
    await getNotificationsQueue().add(`notif-${data.user_id}-${Date.now()}`, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  } catch (err) {
    logger?.warn(
      { err, user_id: data.user_id, type: data.type },
      'enqueueBureauNotification: failed to enqueue notification (swallowed)',
    );
  }
}
