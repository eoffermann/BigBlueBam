import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishToUser } from '../lib/realtime-publish.js';
import type { NotificationJobData } from '@bigbluebam/shared';

export type { NotificationJobData };

export async function processNotificationJob(
  job: Job<NotificationJobData>,
  logger: Logger,
): Promise<void> {
  const {
    user_id,
    project_id,
    org_id,
    task_id,
    type,
    title,
    body,
    category,
    source_app,
    deep_link,
    metadata,
  } = job.data;

  // Cheap guard against the historical "drizzle binds undefined as
  // nothing, postgres reports syntax error at or near ','" failure
  // mode. The processor is the last line of defense; jobs queued
  // with the wrong shape used to spam the System Console on every
  // retry.
  if (!user_id || !type || !title || typeof body !== 'string') {
    throw new Error(
      `notification job ${job.id ?? '?'} is missing required fields: ` +
        `user_id=${user_id ? 'ok' : 'MISSING'} type=${type ? 'ok' : 'MISSING'} ` +
        `title=${title ? 'ok' : 'MISSING'} body=${typeof body === 'string' ? 'ok' : 'MISSING'}`,
    );
  }

  logger.info(
    { jobId: job.id, user_id, project_id, org_id, type, title },
    'Processing notification job',
  );

  const db = getDb();

  const inserted = await db.execute(sql`
    INSERT INTO notifications (
      id, user_id, project_id, org_id, task_id,
      type, title, body, category, source_app, deep_link,
      metadata, is_read, created_at
    )
    VALUES (
      gen_random_uuid(),
      ${user_id},
      ${project_id ?? null},
      ${org_id ?? null},
      ${task_id ?? null},
      ${type},
      ${title},
      ${body},
      ${category ?? null},
      ${source_app ?? 'bbb'},
      ${deep_link ?? null},
      ${JSON.stringify(metadata ?? {})}::jsonb,
      false,
      NOW()
    )
    RETURNING id
  `);

  logger.info(
    { jobId: job.id, user_id, type, title },
    'Notification created successfully',
  );

  // Push a realtime 'notification' event to the recipient's personal room so
  // every app's bell refetches and surfaces the new notification live. This
  // mirrors the api's broadcastToUser(userId, 'notification', ...) by
  // publishing the SAME { room, event } envelope to the SAME Redis channel.
  // Fire-and-forget — the row is already persisted, so a delivery failure is
  // never allowed to fail the job.
  const notification_id =
    (inserted as Array<{ id?: string }> | undefined)?.[0]?.id ?? null;
  publishToUser(user_id, 'notification', {
    action: 'created',
    notification_id,
    category: category ?? null,
    source_app: source_app ?? 'bbb',
  });
}
