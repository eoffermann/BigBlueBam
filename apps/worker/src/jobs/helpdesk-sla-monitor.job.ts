/**
 * Helpdesk SLA breach monitor (Helpdesk_Plan.md G4).
 *
 * Runs on a short cadence (wired to every 5 minutes in worker.ts). Two
 * sweeps:
 *
 *   1. First-response breach: tickets where
 *        first_response_at IS NULL
 *        AND created_at + sla_first_response_minutes < NOW()
 *        AND sla_breached_at IS NULL (idempotency guard)
 *
 *   2. Resolution breach: tickets where
 *        resolved_at IS NULL
 *        AND created_at + sla_resolution_minutes < NOW()
 *        AND NOT EXISTS a helpdesk_sla_breaches row with sla_type='resolution'
 *
 * Per-org SLA minutes live in `helpdesk_settings`, joined via the
 * ticket's `helpdesk_user_id -> helpdesk_users.org_id` path. Tickets
 * whose helpdesk user has a NULL org_id (historical rows pre-0109) are
 * skipped because we can't resolve their SLA policy.
 *
 * For each breach we:
 *   - insert a helpdesk_sla_breaches row with breached_at=NOW()
 *   - stamp `tickets.sla_breached_at = NOW()` for first-response breaches
 *     so they are never re-detected (resolution breaches don't overwrite
 *     a first-response stamp)
 *   - emit a `ticket.sla_breached` Bolt event with source `'helpdesk'`
 *   - stamp helpdesk_sla_breaches.event_emitted_at
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface HelpdeskSlaMonitorJobData {
  /** Optional scope: limit to a single org. */
  org_id?: string;
  /** Row cap per sweep per breach type. Defaults to 100. */
  limit?: number;
}

interface BreachRow {
  ticket_id: string;
  ticket_number: number;
  subject: string;
  priority: string;
  org_id: string;
  created_at: Date;
  minutes_over: number;
}

async function findFirstResponseBreaches(
  orgId: string | undefined,
  limit: number,
): Promise<BreachRow[]> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT
      t.id AS ticket_id,
      t.ticket_number,
      t.subject,
      t.priority,
      u.org_id AS org_id,
      t.created_at,
      FLOOR(
        EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60
        - COALESCE(hs.sla_first_response_minutes, 480)
      )::int AS minutes_over
    FROM tickets t
    INNER JOIN helpdesk_users u ON u.id = t.helpdesk_user_id
    LEFT JOIN helpdesk_settings hs ON hs.org_id = u.org_id
    WHERE t.first_response_at IS NULL
      AND t.sla_breached_at IS NULL
      AND u.org_id IS NOT NULL
      AND t.created_at + (COALESCE(hs.sla_first_response_minutes, 480) || ' minutes')::interval < NOW()
      ${orgId ? sql`AND u.org_id = ${orgId}` : sql``}
    ORDER BY t.created_at ASC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return rows as BreachRow[];
}

async function findResolutionBreaches(
  orgId: string | undefined,
  limit: number,
): Promise<BreachRow[]> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT
      t.id AS ticket_id,
      t.ticket_number,
      t.subject,
      t.priority,
      u.org_id AS org_id,
      t.created_at,
      FLOOR(
        EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60
        - COALESCE(hs.sla_resolution_minutes, 2880)
      )::int AS minutes_over
    FROM tickets t
    INNER JOIN helpdesk_users u ON u.id = t.helpdesk_user_id
    LEFT JOIN helpdesk_settings hs ON hs.org_id = u.org_id
    WHERE t.resolved_at IS NULL
      AND u.org_id IS NOT NULL
      AND t.created_at + (COALESCE(hs.sla_resolution_minutes, 2880) || ' minutes')::interval < NOW()
      AND NOT EXISTS (
        SELECT 1 FROM helpdesk_sla_breaches b
        WHERE b.ticket_id = t.id AND b.sla_type = 'resolution'
      )
      ${orgId ? sql`AND u.org_id = ${orgId}` : sql``}
    ORDER BY t.created_at ASC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return rows as BreachRow[];
}

async function recordBreach(
  row: BreachRow,
  slaType: 'first_response' | 'resolution',
  logger: Logger,
): Promise<boolean> {
  const db = getDb();
  try {
    // 1. Insert audit row.
    const breachRowsRaw = await db.execute(sql`
      INSERT INTO helpdesk_sla_breaches (ticket_id, sla_type, breached_at)
      VALUES (${row.ticket_id}, ${slaType}, NOW())
      RETURNING id
    `);
    const breachRows = Array.isArray(breachRowsRaw)
      ? breachRowsRaw
      : ((breachRowsRaw as { rows?: unknown[] }).rows ?? []);
    const breachId = (breachRows[0] as { id?: string } | undefined)?.id;

    // 2. Stamp sla_breached_at on the ticket (only for first_response so we
    //    don't overwrite an earlier first-response stamp with a later
    //    resolution one).
    if (slaType === 'first_response') {
      await db.execute(sql`
        UPDATE tickets SET sla_breached_at = NOW() WHERE id = ${row.ticket_id}
      `);
    }

    // 3. Emit Bolt event.
    await publishBoltEvent(
      'ticket.sla_breached',
      'helpdesk',
      {
        // #289: the nested shape the Bolt catalog declares (ticket.id, ticket.sla_type); flat keys stay.
        ticket: { id: row.ticket_id, number: row.ticket_number, subject: row.subject, priority: row.priority, sla_type: slaType },
        ticket_id: row.ticket_id,
        ticket_number: row.ticket_number,
        subject: row.subject,
        priority: row.priority,
        sla_type: slaType,
        minutes_over: row.minutes_over,
        created_at: row.created_at,
      },
      row.org_id,
      undefined,
      'system',
    );

    // 4. Stamp event_emitted_at on the breach row.
    if (breachId) {
      await db.execute(sql`
        UPDATE helpdesk_sla_breaches SET event_emitted_at = NOW() WHERE id = ${breachId}
      `);
    }

    logger.info(
      { ticketId: row.ticket_id, slaType, minutesOver: row.minutes_over },
      'helpdesk-sla-monitor: recorded breach',
    );
    return true;
  } catch (err) {
    logger.error(
      {
        ticketId: row.ticket_id,
        slaType,
        err: err instanceof Error ? err.message : String(err),
      },
      'helpdesk-sla-monitor: failed to record breach',
    );
    return false;
  }
}

export async function processHelpdeskSlaMonitorJob(
  job: Job<HelpdeskSlaMonitorJobData>,
  logger: Logger,
): Promise<void> {
  const { org_id, limit } = job.data ?? {};
  const cap = limit ?? 100;

  const [firstResponseBreaches, resolutionBreaches] = await Promise.all([
    findFirstResponseBreaches(org_id, cap),
    findResolutionBreaches(org_id, cap),
  ]);

  logger.info(
    {
      jobId: job.id,
      firstResponseCandidates: firstResponseBreaches.length,
      resolutionCandidates: resolutionBreaches.length,
    },
    'helpdesk-sla-monitor: sweep start',
  );

  let recorded = 0;
  let failed = 0;

  for (const row of firstResponseBreaches) {
    const ok = await recordBreach(row, 'first_response', logger);
    if (ok) recorded += 1;
    else failed += 1;
  }
  for (const row of resolutionBreaches) {
    const ok = await recordBreach(row, 'resolution', logger);
    if (ok) recorded += 1;
    else failed += 1;
  }

  logger.info(
    {
      jobId: job.id,
      firstResponseCandidates: firstResponseBreaches.length,
      resolutionCandidates: resolutionBreaches.length,
      recorded,
      failed,
    },
    'helpdesk-sla-monitor: sweep complete',
  );
}
