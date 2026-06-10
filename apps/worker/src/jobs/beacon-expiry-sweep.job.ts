/**
 * Beacon expiry sweep job — Fridge Cleanout governance (§6.1).
 *
 * Daily cron job that:
 *   Step 1: Active beacons where expires_at <= now() → PendingReview
 *   Step 2: PendingReview beacons where (expires_at + grace_period) <= now() → Archived
 *   Step 3: Draft beacons > 60 days old → delete (notify at 30 days if not already)
 *   Step 4: Enqueue PendingReview beacons for agent verification queue
 */

import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeaconExpirySweepJobData {
  /** Optional org_id to scope the sweep (null = all orgs) */
  organization_id?: string;
}

/** Row shape the sweep queries select/return from beacon_entries. */
interface BeaconSweepRow {
  id: string;
  owned_by: string | null;
  project_id: string | null;
  organization_id: string | null;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export async function processBeaconExpirySweepJob(
  job: Job<BeaconExpirySweepJobData>,
  logger: Logger,
): Promise<void> {
  // Shared connection for the sweep's fan-out queues. Built from the full
  // REDIS_URL (the previous per-queue host/port-only parse dropped the
  // password and would have failed against an auth-required Redis the
  // first time a sweep actually had rows to notify about). Same idiom as
  // slack-import.job.ts::getEmailQueue. Lazy so a sweep with nothing to
  // enqueue never opens it; the finally guarantees no leak on failure.
  const connRef: { conn: IORedis | null } = { conn: null };
  const getQueueConn = (): IORedis => {
    connRef.conn ??= new IORedis(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
      { maxRetriesPerRequest: null },
    );
    return connRef.conn;
  };

  try {
    await runSweep(job, logger, getQueueConn);
  } finally {
    if (connRef.conn) {
      await connRef.conn.quit().catch(() => {
        /* connection teardown is best-effort */
      });
    }
  }
}

async function runSweep(
  job: Job<BeaconExpirySweepJobData>,
  logger: Logger,
  getQueueConn: () => IORedis,
): Promise<void> {
  logger.info({ jobId: job.id }, 'Starting beacon expiry sweep');

  const db = getDb();

  // -------------------------------------------------------------------------
  // Step 1: Active beacons past expiry → PendingReview
  // -------------------------------------------------------------------------

  const step1Rows = (await db.execute(sql`
    UPDATE beacon_entries
    SET status = 'PendingReview',
        updated_at = NOW()
    WHERE status = 'Active'
      AND expires_at <= NOW()
    RETURNING id, owned_by, project_id, organization_id
  `)) as unknown as BeaconSweepRow[];

  logger.info(
    { count: step1Rows.length, step: 1 },
    'Transitioned Active → PendingReview',
  );

  // Enqueue notifications for newly pending beacons
  if (step1Rows.length > 0) {
    const notifQueue = new Queue('notifications', {
      connection: getQueueConn(),
    });

    for (const row of step1Rows) {
      await notifQueue.add('beacon-pending-review', {
        type: 'beacon.pending_review',
        beacon_id: row.id,
        owner_id: row.owned_by,
        project_id: row.project_id,
        organization_id: row.organization_id,
        source_app: 'beacon',
      });
    }

    await notifQueue.close();
  }

  // -------------------------------------------------------------------------
  // Step 2: PendingReview beacons past grace period → Archived
  // -------------------------------------------------------------------------

  const step2Rows = (await db.execute(sql`
    UPDATE beacon_entries be
    SET status = 'Archived',
        updated_at = NOW()
    FROM beacon_expiry_policies bep
    WHERE be.status = 'PendingReview'
      AND (
        (bep.scope = 'Project' AND bep.project_id = be.project_id)
        OR (bep.scope = 'Organization' AND bep.organization_id = be.organization_id AND bep.project_id IS NULL)
        OR (bep.scope = 'System' AND bep.organization_id IS NULL AND bep.project_id IS NULL)
      )
      AND be.expires_at + MAKE_INTERVAL(days => bep.grace_period_days) <= NOW()
    RETURNING be.id, be.owned_by, be.project_id, be.organization_id
  `)) as unknown as BeaconSweepRow[];

  logger.info(
    { count: step2Rows.length, step: 2 },
    'Transitioned PendingReview → Archived (grace expired)',
  );

  // Enqueue archive notifications
  if (step2Rows.length > 0) {
    const notifQueue = new Queue('notifications', {
      connection: getQueueConn(),
    });

    for (const row of step2Rows) {
      await notifQueue.add('beacon-archived', {
        type: 'beacon.archived',
        beacon_id: row.id,
        owner_id: row.owned_by,
        project_id: row.project_id,
        organization_id: row.organization_id,
        source_app: 'beacon',
      });
    }

    await notifQueue.close();
  }

  // -------------------------------------------------------------------------
  // Step 3: Stale drafts — notify at 30 days, delete at 60 days
  // -------------------------------------------------------------------------

  // 3a: Notify creators of 30-day-old drafts (that haven't been notified yet).
  // Single UPDATE..RETURNING instead of SELECT-then-UPDATE: atomic, and it
  // avoids the raw `id = ANY(${jsArray})` template that crashed the sweep
  // with PostgresError 42809 (drizzle binds the JS array as one untyped
  // param, which `ANY` rejects — see the same bug class in bond-api's
  // pipeline.service noted by the e2e suite).
  const drafts30d = (await db.execute(sql`
    UPDATE beacon_entries
    SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"draft_expiry_notified": true}'::jsonb
    WHERE status = 'Draft'
      AND created_at < NOW() - INTERVAL '30 days'
      AND created_at >= NOW() - INTERVAL '60 days'
      AND NOT COALESCE((metadata->>'draft_expiry_notified')::boolean, false)
    RETURNING id, owned_by, project_id, organization_id
  `)) as unknown as BeaconSweepRow[];

  if (drafts30d.length > 0) {
    logger.info(
      { count: drafts30d.length, step: '3a' },
      'Notified owners of 30-day stale drafts',
    );
  }

  // 3b: Delete drafts older than 60 days
  const deletedDrafts = (await db.execute(sql`
    DELETE FROM beacon_entries
    WHERE status = 'Draft'
      AND created_at < NOW() - INTERVAL '60 days'
    RETURNING id, owned_by
  `)) as unknown as Array<Pick<BeaconSweepRow, 'id' | 'owned_by'>>;

  logger.info(
    { count: deletedDrafts.length, step: '3b' },
    'Deleted stale drafts (> 60 days)',
  );

  // -------------------------------------------------------------------------
  // Step 4: Enqueue all PendingReview beacons for agent verification
  // -------------------------------------------------------------------------

  const pendingBeacons = (await db.execute(sql`
    SELECT id, owned_by, project_id, organization_id
    FROM beacon_entries
    WHERE status = 'PendingReview'
  `)) as unknown as BeaconSweepRow[];

  if (pendingBeacons.length > 0) {
    const agentQueue = new Queue('beacon-agent-verify', {
      connection: getQueueConn(),
    });

    for (const row of pendingBeacons) {
      await agentQueue.add('verify', {
        beacon_id: row.id,
        project_id: row.project_id,
        organization_id: row.organization_id,
      });
    }

    await agentQueue.close();
  }

  logger.info(
    { count: pendingBeacons.length, step: 4 },
    'Enqueued PendingReview beacons for agent verification',
  );

  logger.info(
    {
      expired: step1Rows.length,
      graceExpired: step2Rows.length,
      draftsNotified: drafts30d.length,
      draftsDeleted: deletedDrafts.length,
      agentQueue: pendingBeacons.length,
    },
    'Beacon expiry sweep complete',
  );
}
