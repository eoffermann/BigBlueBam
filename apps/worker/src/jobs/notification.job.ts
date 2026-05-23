import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import type { NotificationJobData } from '@bigbluebam/shared';

export type { NotificationJobData };

export async function processNotificationJob(
  job: Job<NotificationJobData>,
  logger: Logger,
): Promise<void> {
  const { user_id, project_id, task_id, type, title, body, category, source_app, deep_link } = job.data;

  logger.info(
    { jobId: job.id, user_id, project_id, type, title },
    'Processing notification job',
  );

  const db = getDb();

  await db.execute(sql`
    INSERT INTO notifications (id, user_id, project_id, task_id, type, title, body, category, source_app, deep_link, is_read, created_at)
    VALUES (
      gen_random_uuid(),
      ${user_id},
      ${project_id},
      ${task_id ?? null},
      ${type},
      ${title},
      ${body},
      ${category ?? null},
      ${source_app ?? 'bbb'},
      ${deep_link ?? null},
      false,
      NOW()
    )
  `);

  logger.info(
    { jobId: job.id, user_id, type, title },
    'Notification created successfully',
  );
}
