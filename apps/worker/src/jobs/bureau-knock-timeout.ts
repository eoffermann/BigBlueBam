/**
 * Bureau knock-timeout job (Agent B, workstream 5).
 *
 * Spec: docs/plans/bureau-design-document.md §4.3 — when a visitor knocks on a
 * closed office door and the owner does not respond within 30 seconds the
 * knock auto-resolves as `timed_out`. The visitor is notified, the audit row
 * is closed, and a Bolt event fires so downstream automations (e.g. "summon
 * the visitor instead", "post a note in Banter") can react.
 *
 * Enqueue site:
 *   apps/bureau-api/src/routes/knocks.routes.ts POST /v1/knocks
 *   apps/bureau-api/src/routes/ws.routes.ts     'knock' message handler
 *
 * Both call into a shared scheduleKnockTimeout helper that pushes a job onto
 * the `bureau-knock-timeout` queue with `delay: 30_000`.
 *
 * Idempotency:
 *   The job is a no-op when `bureau_knocks.status != 'pending'` — that
 *   covers the common case where the owner already admitted / declined /
 *   deferred the knock before the timer fired, AND the rare case where two
 *   timeout jobs land for the same knock (e.g. enqueued twice during a brief
 *   double-submit). We never DELETE the row; the audit trail keeps the
 *   final status forever.
 *
 * Bolt event:
 *   `knock.resolved` with `source: 'bureau'` and `decision: 'timed_out'`,
 *   per the §14 catalog. publishBoltEvent is fire-and-forget — a Bolt outage
 *   does not block the DB update or the WS notification.
 */

import type { Job } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BureauKnockTimeoutJobData {
  /** UUID of the bureau_knocks row to time out. */
  knock_id: string;
}

type KnockRow = {
  id: string;
  org_id: string;
  room_id: string;
  visitor_id: string;
  owner_id: string;
  status: string;
} & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userChannel(userId: string): string {
  return `user:${userId}`;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processBureauKnockTimeoutJob(
  job: Job<BureauKnockTimeoutJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const { knock_id: knockId } = job.data ?? {};
  if (!knockId) {
    logger.warn({ jobId: job.id }, 'bureau-knock-timeout: missing knock_id, skipping');
    return;
  }

  const db = getDb();

  // 1. Load the knock row. postgres-js db.execute returns the rows array
  // directly (helpdesk-task-create.job.ts uses the same pattern).
  const result = await db.execute<KnockRow>(sql`
    SELECT id, org_id, room_id, visitor_id, owner_id, status
    FROM bureau_knocks
    WHERE id = ${knockId}
    LIMIT 1
  `);
  const knock = (result as unknown as KnockRow[])[0];

  if (!knock) {
    logger.debug(
      { jobId: job.id, knockId },
      'bureau-knock-timeout: knock not found (already deleted?)',
    );
    return;
  }

  // 2. Already resolved → no-op. The owner answered before the timer fired.
  if (knock.status !== 'pending') {
    logger.debug(
      { jobId: job.id, knockId, status: knock.status },
      'bureau-knock-timeout: knock already resolved, skipping',
    );
    return;
  }

  // 3. Flip to timed_out + stamp resolved_at.
  const resolvedAt = new Date();
  await db.execute(sql`
    UPDATE bureau_knocks
    SET status = 'timed_out', resolved_at = ${resolvedAt}
    WHERE id = ${knockId} AND status = 'pending'
  `);

  // 4. Notify the visitor over their personal Redis channel so any open
  //    Bureau WS session repaints the knock UI.
  try {
    const payload = JSON.stringify({
      type: 'knock_resolved',
      data: {
        knockId,
        decision: 'timed_out',
      },
      timestamp: resolvedAt.toISOString(),
    });
    await redis.publish(userChannel(knock.visitor_id), payload);
  } catch (err) {
    logger.warn(
      { err, knockId, visitorId: knock.visitor_id },
      'bureau-knock-timeout: failed to publish knock_resolved (swallowed)',
    );
  }

  // 5. Bolt event — knock.resolved with decision: 'timed_out'. Fire-and-forget.
  await publishBoltEvent(
    'knock.resolved',
    'bureau',
    {
      knock: { id: knockId, status: 'timed_out' },
      room: { id: knock.room_id },
      visitor: { id: knock.visitor_id },
      owner: { id: knock.owner_id },
      decision: 'timed_out',
      resolved_at: resolvedAt.toISOString(),
      actor: { id: knock.owner_id },
      org: { id: knock.org_id },
    },
    knock.org_id,
    knock.owner_id,
    'system',
  ).catch((err: unknown) => {
    logger.warn(
      { err, knockId },
      'bureau-knock-timeout: bolt emit failed (swallowed)',
    );
  });

  logger.info(
    { jobId: job.id, knockId, roomId: knock.room_id, visitorId: knock.visitor_id },
    'bureau-knock-timeout: knock timed out',
  );
}
