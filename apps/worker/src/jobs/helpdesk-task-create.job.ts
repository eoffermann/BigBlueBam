import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

// ── Job types ─────────────────────────────────────────────────────

export interface HelpdeskTaskCreateJobData {
  ticket_id: string;
  ticket_number: number;
  project_id: string;
  phase_id: string | null;
  label_ids: string[];
  title: string;
  description: string;
  description_plain: string;
  priority: string;
  human_id: string;
  helpdesk_customer_id: string;
  helpdesk_customer_email: string;
  retry_count: number;
}

// ── Processor ─────────────────────────────────────────────────────

/**
 * Async fallback for helpdesk ticket → Bam task creation (HB-23).
 *
 * When a customer submits a ticket, helpdesk-api tries to create the
 * corresponding Bam task inline in the same transaction. If that fails
 * due to a transient error (deadlock, connection blip, etc.), the ticket
 * is rolled back and this job is enqueued. The job retries task creation
 * and then back-links the task_id onto the already-persisted ticket.
 *
 * Idempotency: if the ticket already has a task_id, this job is a no-op.
 */
export async function processHelpdeskTaskCreateJob(
  job: Job<HelpdeskTaskCreateJobData>,
  logger: Logger,
): Promise<void> {
  const data = job.data;

  logger.info(
    {
      jobId: job.id,
      ticket_id: data.ticket_id,
      ticket_number: data.ticket_number,
      project_id: data.project_id,
      retry_count: data.retry_count,
    },
    'Processing helpdesk task create job',
  );

  const db = getDb();

  // Idempotency guard: skip if ticket already has a linked task.
  const existing = await db.execute<{ task_id: string | null }>(sql`
    SELECT task_id FROM tickets WHERE id = ${data.ticket_id} LIMIT 1
  `);

  const existingRow = existing[0] as { task_id: string | null } | undefined;
  if (!existingRow) {
    logger.warn(
      { jobId: job.id, ticket_id: data.ticket_id },
      'Ticket not found, skipping task creation',
    );
    return;
  }

  if (existingRow.task_id) {
    logger.info(
      { jobId: job.id, ticket_id: data.ticket_id, task_id: existingRow.task_id },
      'Ticket already has linked task, skipping',
    );
    return;
  }

  const customFields = {
    helpdesk_customer_email: data.helpdesk_customer_email,
    helpdesk_customer_id: data.helpdesk_customer_id,
    helpdesk_ticket_id: data.ticket_id,
    helpdesk_ticket_number: data.ticket_number,
  };

  // Insert task + back-link to ticket atomically.
  const inserted = await db.execute<{ id: string }>(sql`
    WITH new_task AS (
      INSERT INTO tasks (
        id, project_id, org_id, human_id, title, description, description_plain,
        phase_id, priority, labels, custom_fields, created_at, updated_at
      ) VALUES (
        gen_random_uuid(),
        ${data.project_id},
        (SELECT org_id FROM projects WHERE id = ${data.project_id}),
        ${data.human_id},
        ${data.title},
        ${data.description},
        ${data.description_plain},
        ${data.phase_id},
        ${data.priority},
        ${JSON.stringify(data.label_ids)}::jsonb,
        ${JSON.stringify(customFields)}::jsonb,
        NOW(),
        NOW()
      )
      RETURNING id
    )
    UPDATE tickets
    SET task_id = (SELECT id FROM new_task),
        updated_at = NOW()
    WHERE id = ${data.ticket_id}
    RETURNING task_id AS id
  `);

  const row = inserted[0] as { id: string } | undefined;
  if (!row) {
    throw new Error('HELPDESK_TASK_CREATE_FAILED');
  }

  logger.info(
    {
      jobId: job.id,
      ticket_id: data.ticket_id,
      task_id: row.id,
      project_id: data.project_id,
    },
    'Helpdesk task created and linked to ticket',
  );
}
