// §13 Wave 4 scheduled banter — BullMQ consumer for scheduled post delivery.
//
// Job payload: { scheduled_message_id }. At fire time the worker:
//   1. Loads the durable row from banter_scheduled_messages.
//   2. If status != 'pending', returns (idempotent no-op).
//   3. Re-verifies the author is still a channel member (or org staff).
//      If revoked, marks the row 'failed' with defer_reason='membership_revoked'
//      and publishes nothing.
//   4. Inserts the banter_messages row and updates channel denormalized
//      counters exactly like apps/banter-api/src/routes/message.routes.ts
//      does on the immediate path.
//   5. Flips the scheduled row to 'delivered' and records delivered_at /
//      delivered_message_id.
//   6. Emits the message.scheduled_delivered Bolt event.
//   7. Publishes a realtime message.created event over Redis Pub/Sub so
//      open WS clients see the message instantly.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface BanterScheduledPostJobData {
  scheduled_message_id: string;
}

interface ScheduledRow {
  id: string;
  org_id: string;
  channel_id: string;
  author_id: string;
  content: string;
  content_format: string;
  thread_parent_id: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  scheduled_at: Date;
}

function normaliseRows<T>(raw: unknown): T[] {
  return (
    Array.isArray(raw)
      ? (raw as T[])
      : (((raw as { rows?: unknown[] })?.rows ?? []) as T[])
  );
}

async function broadcastMessageCreated(
  redis: Redis,
  channelId: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      room: `banter:channel:${channelId}`,
      event: {
        type: 'message.created',
        data,
        timestamp: new Date().toISOString(),
      },
    });
    await redis.publish('banter:events', payload);
  } catch {
    // Non-critical. WS clients reconnect will pull the message via REST.
  }
}

export async function processBanterScheduledPostJob(
  job: Job<BanterScheduledPostJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const scheduledId = job.data?.scheduled_message_id;
  if (!scheduledId) {
    logger.warn({ jobId: job.id }, 'banter-scheduled-post: missing scheduled_message_id');
    return;
  }

  const rowsRaw = await db.execute(sql`
    SELECT id, org_id, channel_id, author_id, content, content_format,
           thread_parent_id, metadata, status, scheduled_at
    FROM banter_scheduled_messages
    WHERE id = ${scheduledId}
    LIMIT 1
  `);
  const [row] = normaliseRows<ScheduledRow>(rowsRaw);
  if (!row) {
    logger.warn({ jobId: job.id, scheduledId }, 'banter-scheduled-post: row not found');
    return;
  }
  if (row.status !== 'pending') {
    logger.info(
      { jobId: job.id, scheduledId, status: row.status },
      'banter-scheduled-post: skipping non-pending row',
    );
    return;
  }

  // Re-verify channel membership. Matches the banter-api policy: author must
  // have a row in banter_channel_memberships, OR be an org owner/admin/superuser
  // for the channel's org. Viewer role on the channel is forbidden from posting.
  const membershipRaw = await db.execute(sql`
    SELECT
      m.role AS channel_role,
      u.role AS user_role,
      u.is_superuser AS is_superuser,
      u.org_id AS user_org_id,
      c.org_id AS channel_org_id
    FROM banter_channels c
    LEFT JOIN banter_channel_memberships m
      ON m.channel_id = c.id AND m.user_id = ${row.author_id}
    LEFT JOIN users u ON u.id = ${row.author_id}
    WHERE c.id = ${row.channel_id}
    LIMIT 1
  `);
  const [membership] = normaliseRows<{
    channel_role: string | null;
    user_role: string | null;
    is_superuser: boolean | null;
    user_org_id: string | null;
    channel_org_id: string | null;
  }>(membershipRaw);

  const orgMatch = membership?.user_org_id === membership?.channel_org_id;
  const isOrgStaff =
    !!membership?.is_superuser ||
    (membership?.user_role && ['owner', 'admin'].includes(membership.user_role));
  const channelRole = membership?.channel_role ?? null;
  const allowedByMembership =
    channelRole !== null && channelRole !== 'viewer';

  if (!orgMatch || (!allowedByMembership && !isOrgStaff)) {
    await db.execute(sql`
      UPDATE banter_scheduled_messages
      SET status = 'failed', defer_reason = 'membership_revoked'
      WHERE id = ${row.id}
    `);
    logger.warn(
      { jobId: job.id, scheduledId, authorId: row.author_id, channelId: row.channel_id },
      'banter-scheduled-post: author membership revoked, row marked failed',
    );
    return;
  }

  // Sanitize content again? The row was sanitized when inserted. Trust it.
  const contentPlain = row.content.replace(/<[^>]*>/g, '').slice(0, 500);

  const insertResult = await db.execute(sql`
    INSERT INTO banter_messages
      (channel_id, author_id, thread_parent_id, content, content_plain,
       content_format, metadata, edit_permission)
    VALUES (${row.channel_id}, ${row.author_id}, ${row.thread_parent_id},
            ${row.content}, ${contentPlain}, ${row.content_format},
            ${row.metadata ? JSON.stringify(row.metadata) : '{}'}::jsonb, 'own')
    RETURNING id, created_at
  `);
  const [inserted] = normaliseRows<{ id: string; created_at: Date }>(insertResult);
  if (!inserted) {
    logger.error({ jobId: job.id, scheduledId }, 'banter-scheduled-post: insert returned no row');
    return;
  }

  // Bump channel counters exactly like the immediate POST path.
  await db.execute(sql`
    UPDATE banter_channels
    SET last_message_at = NOW(),
        last_message_preview = ${contentPlain.slice(0, 200)},
        message_count = message_count + 1
    WHERE id = ${row.channel_id}
  `);

  // If it is a thread reply, update parent reply_count / last_reply_at.
  if (row.thread_parent_id) {
    await db.execute(sql`
      UPDATE banter_messages
      SET reply_count = reply_count + 1,
          last_reply_at = NOW()
      WHERE id = ${row.thread_parent_id}
    `);
  }

  // Flip status to delivered.
  const deliveredAt = new Date();
  await db.execute(sql`
    UPDATE banter_scheduled_messages
    SET status = 'delivered',
        delivered_message_id = ${inserted.id},
        delivered_at = ${deliveredAt.toISOString()}::timestamptz
    WHERE id = ${row.id}
  `);

  // Emit Bolt event (fire-and-forget).
  await publishBoltEvent(
    'message.scheduled_delivered',
    'banter',
    {
      scheduled_message_id: row.id,
      message_id: inserted.id,
      channel_id: row.channel_id,
      delivered_at: deliveredAt.toISOString(),
    },
    row.org_id,
    row.author_id,
    'user',
  );

  // Realtime broadcast so open WS clients see the message.
  await broadcastMessageCreated(redis, row.channel_id, {
    message: {
      id: inserted.id,
      channel_id: row.channel_id,
      author_id: row.author_id,
      content: row.content,
      content_plain: contentPlain,
      content_format: row.content_format,
      thread_parent_id: row.thread_parent_id,
      created_at: inserted.created_at,
      scheduled: true,
    },
  });

  logger.info(
    { jobId: job.id, scheduledId, messageId: inserted.id, channelId: row.channel_id },
    'banter-scheduled-post: delivered',
  );
}

// ---------------------------------------------------------------------------
// Startup reconciler
// ---------------------------------------------------------------------------

export interface ReconcileScheduledPostsOptions {
  /** Optional: cap how many rows we look at to avoid a thundering herd. */
  limit?: number;
}

/**
 * Scan banter_scheduled_messages for pending rows and re-enqueue their
 * BullMQ job if it is missing. Safe to call repeatedly: BullMQ's jobId
 * dedup means a second add with the same jobId is a no-op.
 *
 * Horizon: now-1h..now+30d. Rows older than 1h in the past are skipped
 * (they'll fire immediately if added, which is the right behaviour for a
 * Redis-was-flushed restart), and rows further than 30d away are left to
 * a later reconcile pass (they'll still be in the DB).
 *
 * Caller passes a preconstructed BullMQ Queue so we do not open a second
 * Redis connection.
 */
export async function reconcileScheduledPosts(
  queueAdd: (
    jobId: string,
    data: BanterScheduledPostJobData,
    delayMs: number,
  ) => Promise<void>,
  logger: Logger,
  opts: ReconcileScheduledPostsOptions = {},
): Promise<number> {
  const db = getDb();
  const limit = opts.limit ?? 5000;
  const rowsRaw = await db.execute(sql`
    SELECT id, scheduled_at
    FROM banter_scheduled_messages
    WHERE status = 'pending'
      AND scheduled_at BETWEEN (NOW() - INTERVAL '1 hour')
                          AND (NOW() + INTERVAL '30 days')
    ORDER BY scheduled_at ASC
    LIMIT ${limit}
  `);
  const rows = normaliseRows<{ id: string; scheduled_at: Date }>(rowsRaw);
  const now = Date.now();
  let reEnqueued = 0;
  for (const r of rows) {
    const target = new Date(r.scheduled_at).getTime();
    const delay = Math.max(0, target - now);
    try {
      await queueAdd(`banter-scheduled-post:${r.id}`, { scheduled_message_id: r.id }, delay);
      reEnqueued += 1;
    } catch (err) {
      logger.error(
        { scheduledId: r.id, err: err instanceof Error ? err.message : String(err) },
        'banter-scheduled-post: reconcile enqueue failed',
      );
    }
  }
  logger.info({ reEnqueued, scanned: rows.length }, 'banter-scheduled-post: reconcile complete');
  return reEnqueued;
}
