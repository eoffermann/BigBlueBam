/**
 * Bam task.overdue sweep job (low-latency live path for the task.overdue Bolt event).
 *
 * The task.overdue event is registered in the Bolt catalog (source `bam`) and is consumed by the
 * tpl_notify_task_overdue automation template and by Bulwark/Burn state bindings, but historically
 * nothing published it: Bulwark's beachhead relied solely on its 30-min state-reconcile direct
 * query. This sweep supplies the live path. It runs every 30 minutes (wired in worker.ts) and finds
 * tasks that are past their due_date, not completed, not in a `done`-category state, and not yet
 * alerted for the current due-date arming. For each it emits a `task.overdue` event and stamps
 * `overdue_alerted_at = NOW()`.
 *
 * Shared-arm-key convergence (CRITICAL):
 *   The emitted payload carries `trigger_at = <task.due_date as ISO>`. Bulwark's bam:task.overdue
 *   state binding derives its arm-key epoch from tasks.due_date (a DATE, normalized to a UTC day),
 *   and its live drain derives the same epoch from this event's `trigger_at`. Setting trigger_at to
 *   the due_date (not NOW()) makes the live path and the 30-min reconcile compute a BYTE-IDENTICAL
 *   arm key, so the two paths converge on one deterministic key and never double-arm an obligation.
 *
 * Idempotency model:
 *   `overdue_alerted_at IS NULL` gates the SELECT, so a second run of the sweep re-selects nothing
 *   for an already-alerted task. The marker is reset to NULL by the task.service due_date-change
 *   path, so a re-dated task re-arms and fires once for its new date (mirrors
 *   bond_deals.rotting_alerted_at, which resets on stage change).
 *
 * Ordering decision (update-AFTER-emission): identical to bond-stale-deals. We emit first, then
 * stamp the marker. publishBoltEvent is fire-and-forget and swallows its own failures, so a genuine
 * bolt-api outage still stamps the marker (we will NOT retry that task next sweep) rather than
 * re-flooding on recovery; a crash between emit and stamp re-fires the task once next sweep, which
 * is the safe direction for a missed deadline.
 *
 * Runs every 30 minutes. The Bulwark 30-min state-reconcile is the durable backstop.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface BamTaskOverdueSweepJobData {
  /** Optional: scope the sweep to a single organization for targeted runs. */
  organization_id?: string;
  /** Max tasks to process per run. Defaults to 500. */
  limit?: number;
  /** Rows per emit/update batch for progress logging. Defaults to 100. */
  batch_size?: number;
}

interface OverdueTaskRow {
  id: string;
  org_id: string;
  human_id: string;
  title: string;
  project_id: string;
  phase_id: string | null;
  priority: string;
  due_date: string;
  days_overdue: number;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  project_name: string;
  org_name: string;
  org_slug: string;
}

export async function processBamTaskOverdueSweepJob(
  job: Job<BamTaskOverdueSweepJobData>,
  logger: Logger,
): Promise<void> {
  const { organization_id, limit, batch_size } = job.data ?? {};
  const cap = limit ?? 500;
  const batchSize = batch_size ?? 100;
  logger.info(
    { jobId: job.id, organization_id, limit: cap, batchSize },
    'bam-task-overdue-sweep: sweep start',
  );

  const db = getDb();

  // Candidate set: overdue, not completed, not yet alerted, and not in a done-category state.
  // The org owner comes from tasks.org_id (denormalized) with a projects fallback so a task whose
  // org_id was never backfilled still resolves an org. task_states LEFT JOIN + the category guard
  // keeps tasks with a NULL state (no board state yet) eligible, while excluding terminal states.
  const rowsRaw = await db.execute(sql`
    SELECT
      t.id,
      COALESCE(t.org_id, p.org_id) AS org_id,
      t.human_id,
      t.title,
      t.project_id,
      t.phase_id,
      t.priority,
      t.due_date,
      (CURRENT_DATE - t.due_date)::int AS days_overdue,
      t.assignee_id,
      u.name AS assignee_name,
      u.email AS assignee_email,
      p.name AS project_name,
      o.name AS org_name,
      o.slug AS org_slug
    FROM tasks t
    INNER JOIN projects p ON p.id = t.project_id
    INNER JOIN organizations o ON o.id = COALESCE(t.org_id, p.org_id)
    LEFT JOIN task_states s ON s.id = t.state_id
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.due_date < CURRENT_DATE
      AND t.overdue_alerted_at IS NULL
      AND t.completed_at IS NULL
      AND (s.category IS NULL OR s.category <> 'done')
      ${organization_id ? sql`AND COALESCE(t.org_id, p.org_id) = ${organization_id}` : sql``}
    ORDER BY t.due_date ASC
    LIMIT ${cap}
  `);

  // drizzle-orm's db.execute returns an array-like on postgres-js and a { rows } wrapper on some
  // other drivers. Normalise both, matching the bond-stale-deals pattern.
  const rows: OverdueTaskRow[] = (
    Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? [])
  ) as OverdueTaskRow[];

  logger.info({ jobId: job.id, count: rows.length }, 'bam-task-overdue-sweep: candidates found');

  if (rows.length === 0) {
    logger.info({ jobId: job.id }, 'bam-task-overdue-sweep: sweep complete (no-op)');
    return;
  }

  let alerted = 0;
  let failed = 0;

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    for (const row of batch) {
      try {
        // trigger_at MUST equal the task's due_date (as ISO) so the live event and the Bulwark
        // state-reconcile derive the SAME UTC-day arm key. Payload is NESTED (task.*, project.*,
        // org.*) to match the Bolt catalog field names and the bolt-api -> bulwark dispatch hook,
        // which lifts scope_fields via nested paths like `task.id` / `task.project_id`.
        const triggerAt = new Date(row.due_date).toISOString();
        await publishBoltEvent(
          'task.overdue',
          'bam',
          {
            task: {
              id: row.id,
              human_id: row.human_id,
              title: row.title,
              project_id: row.project_id,
              phase_id: row.phase_id,
              priority: row.priority,
              due_date: row.due_date,
              days_overdue: row.days_overdue,
              url: `/b3/tasks/${row.human_id}`,
              assignee_id: row.assignee_id,
              assignee_name: row.assignee_name,
              assignee_email: row.assignee_email,
            },
            project: { id: row.project_id, name: row.project_name },
            org: { id: row.org_id, name: row.org_name, slug: row.org_slug },
            trigger_at: triggerAt,
          },
          row.org_id,
          undefined,
          'system',
        );

        // Stamp the marker AFTER emit (see header). One task per arming.
        await db.execute(sql`
          UPDATE tasks
          SET overdue_alerted_at = NOW()
          WHERE id = ${row.id}
        `);

        alerted += 1;
      } catch (err) {
        // publishBoltEvent swallows its own errors, but the UPDATE can still fail. Log per-task
        // and keep going so one bad row never kills the batch.
        failed += 1;
        logger.error(
          {
            taskId: row.id,
            orgId: row.org_id,
            err: err instanceof Error ? err.message : String(err),
          },
          'bam-task-overdue-sweep: failed to process task',
        );
      }
    }
    logger.info(
      {
        jobId: job.id,
        processed: Math.min(start + batch.length, rows.length),
        total: rows.length,
        alerted,
        failed,
      },
      'bam-task-overdue-sweep: batch complete',
    );
  }

  logger.info(
    { jobId: job.id, found: rows.length, alerted, failed },
    'bam-task-overdue-sweep: sweep complete',
  );
}
