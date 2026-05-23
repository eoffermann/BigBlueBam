/**
 * Notification Fan-Out Service
 *
 * Accepts a notification payload and a set of delivery channels, then
 * dispatches the notification to each channel independently. Failures
 * on one channel do not block delivery on the others.
 *
 * Supported channels:
 *   - email: Enqueues a BullMQ email job (worker picks it up)
 *   - banter_dm: Posts a DM to the target user via Banter API
 *   - brief_comment: (Placeholder) Would post a comment on a Brief doc
 *
 * This is the foundation for Cross_Product_Plan G6 (unified notification
 * dispatcher). Currently wired from task.assigned in the task service.
 */

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '../env.js';
import type { NotificationJobData } from '@bigbluebam/shared';

export type { NotificationJobData };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationChannel = 'email' | 'banter_dm' | 'brief_comment';

export interface NotificationPayload {
  /** The recipient user id. */
  recipient_user_id: string;
  /** The recipient email (required for email channel). */
  recipient_email?: string;
  /** Short subject / title. */
  subject: string;
  /** Longer body text (plain text or markdown). */
  body: string;
  /** Optional deep link URL. */
  url?: string;
  /** The org context. */
  org_id: string;
  /** Who triggered the notification. */
  actor_name?: string;
}

export interface FanoutResult {
  channel: NotificationChannel;
  status: 'sent' | 'skipped' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// BullMQ email queue (producer side)
// ---------------------------------------------------------------------------

let _emailQueue: Queue | null = null;

function getEmailQueue(): Queue {
  if (!_emailQueue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _emailQueue = new Queue('email', { connection });
  }
  return _emailQueue;
}

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

// ---------------------------------------------------------------------------
// Channel dispatchers
// ---------------------------------------------------------------------------

async function dispatchEmail(payload: NotificationPayload): Promise<FanoutResult> {
  if (!payload.recipient_email) {
    return { channel: 'email', status: 'skipped', error: 'No recipient email' };
  }

  try {
    await getEmailQueue().add(
      `notify-${payload.recipient_user_id}-${Date.now()}`,
      {
        to: payload.recipient_email,
        subject: payload.subject,
        body: payload.body,
        url: payload.url,
        org_id: payload.org_id,
        type: 'notification',
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return { channel: 'email', status: 'sent' };
  } catch (err) {
    return {
      channel: 'email',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dispatchBanterDm(payload: NotificationPayload): Promise<FanoutResult> {
  try {
    // Internal HTTP call to banter-api. In production this resolves to
    // the compose service name. Falls back gracefully if banter-api is
    // not reachable (fire-and-forget pattern).
    const banterBaseUrl = process.env.BANTER_API_URL ?? 'http://banter-api:4002';
    const res = await fetch(`${banterBaseUrl}/v1/internal/dm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Internal service token; banter-api trusts it for server-to-server calls.
        'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN ?? '',
      },
      body: JSON.stringify({
        recipient_user_id: payload.recipient_user_id,
        message: `**${payload.subject}**\n\n${payload.body}${payload.url ? `\n\n[View](${payload.url})` : ''}`,
        org_id: payload.org_id,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return {
        channel: 'banter_dm',
        status: 'error',
        error: `Banter API returned ${res.status}`,
      };
    }

    return { channel: 'banter_dm', status: 'sent' };
  } catch (err) {
    return {
      channel: 'banter_dm',
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function dispatchBriefComment(_payload: NotificationPayload): Promise<FanoutResult> {
  // Placeholder: Brief comment notifications will be wired when
  // brief-api exposes an internal comment creation endpoint.
  return { channel: 'brief_comment', status: 'skipped', error: 'Not yet implemented' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DISPATCHERS: Record<NotificationChannel, (p: NotificationPayload) => Promise<FanoutResult>> = {
  email: dispatchEmail,
  banter_dm: dispatchBanterDm,
  brief_comment: dispatchBriefComment,
};

/**
 * Fan out a notification to multiple delivery channels.
 *
 * Each channel is dispatched independently. A failure on one channel
 * does not prevent delivery on the others.
 *
 * @returns Array of per-channel results for observability.
 */
export async function fanoutNotification(
  payload: NotificationPayload,
  channels: NotificationChannel[],
): Promise<FanoutResult[]> {
  const results = await Promise.allSettled(
    channels.map((ch) => {
      const dispatcher = DISPATCHERS[ch];
      if (!dispatcher) {
        return Promise.resolve({
          channel: ch,
          status: 'skipped' as const,
          error: `Unknown channel: ${ch}`,
        });
      }
      return dispatcher(payload);
    }),
  );

  return results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { channel: 'email' as NotificationChannel, status: 'error' as const, error: String(r.reason) },
  );
}

/**
 * Enqueue a persistent notification into the `notifications` BullMQ queue.
 * The worker picks this up and inserts a row into the `notifications` table,
 * which is what `list_my_notifications` reads.
 */
export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  await getNotificationsQueue().add(
    `notif-${data.user_id}-${Date.now()}`,
    data,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );
}
