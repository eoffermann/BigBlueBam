/**
 * Braid match-on-ingest worker (Braid design spec §4 / §6). Event-driven queue consumer.
 *
 * Given { org_id, source_type, source_id } (enqueued by braid-api's /internal/events route
 * off a bolt-api dispatch, or by the lazy resolve path), it reads the source row directly
 * via Postgres, normalizes match keys, acquires the ALL-KEYS advisory lock, create-or-
 * attaches the identity, blocks, scores, and routes each profile pair to an autonomy band
 * (auto-merge / review / no-op), running N-way bridging inside the single locked
 * transaction. The refs-only Bolt events are fired best-effort after commit and their
 * transactional-outbox markers stamped to the observed updated_at.
 *
 * Idempotency: the identity upsert is keyed on UNIQUE(org, source_type, source_id); the
 * merge CAS and the FOR UPDATE + merged_away re-check make a duplicate delivery a no-op.
 * Bounded retry + exponential backoff via BullMQ `attempts`; on final give-up the failed
 * handler DLQs by flipping braid_identities.needs_rescan=true so the nightly rescan
 * re-processes it (spec ST-r2-7, modeled on agent-webhook-dispatch/-dlq).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { and, eq, sql } from 'drizzle-orm';
import type { BraidMatchOnIngestJobData } from '@bigbluebam/shared';
import { publishBoltEvent } from '../utils/bolt-events.js';
import { getDb } from '../utils/db.js';
import { processBraidIngest } from '../lib/braid/engine.js';
import { braidProfiles, braidIdentities } from '../lib/braid/schema.js';

export type { BraidMatchOnIngestJobData } from '@bigbluebam/shared';

export async function processBraidMatchOnIngestJob(
  job: Job<BraidMatchOnIngestJobData>,
  logger: Logger,
): Promise<void> {
  const { org_id, source_type, source_id, seeded } = job.data;
  const started = Date.now();
  logger.info(
    { jobId: job.id, org_id, source_type, source_id, seeded, attempt: job.attemptsMade + 1 },
    'braid-match-on-ingest: starting',
  );

  const db = getDb() as never;
  const result = await processBraidIngest(db, { orgId: org_id, sourceType: source_type, sourceId: source_id }, logger);

  if (result.status === 'skipped') {
    logger.info({ jobId: job.id, reason: result.reason, elapsedMs: Date.now() - started }, 'braid-match-on-ingest: skipped');
    return;
  }

  // Post-commit, best-effort: fire refs-only Bolt events and stamp the outbox markers to the
  // OBSERVED updated_at (never now(), spec 4.4 ST3-1). A crash here leaves a correct golden
  // record with a stale marker that the rescan reconciles and replays.
  for (const ev of result.events) {
    await publishBoltEvent(ev.event, ev.source, ev.payload, org_id, ev.actorId, ev.actorType);
    if (ev.stampProfileId && ev.stampUpdatedAt) {
      try {
        await getDb()
          .update(braidProfiles)
          .set({ last_event_published_at: ev.stampUpdatedAt })
          .where(and(eq(braidProfiles.id, ev.stampProfileId), eq(braidProfiles.updated_at, ev.stampUpdatedAt)));
      } catch (err) {
        logger.warn({ err, profileId: ev.stampProfileId }, 'braid-match-on-ingest: outbox marker stamp failed (rescan will reconcile)');
      }
    }
  }

  logger.info(
    {
      jobId: job.id,
      org_id,
      identityId: result.identityId,
      homeProfileId: result.homeProfileId,
      merges: result.merges,
      candidates: result.candidates,
      noops: result.noops,
      attached: result.attached,
      events: result.events.length,
      elapsedMs: Date.now() - started,
    },
    'braid-match-on-ingest: done',
  );
}

// DLQ give-up: called from the worker's `failed` handler when BullMQ has exhausted all
// attempts. Sets braid_identities.needs_rescan=true so the nightly rescan re-processes the
// row (spec 4.6 / ST-r2-7). Best-effort and never throws (mirrors agent-webhook-dlq).
export async function braidIngestDlq(
  data: BraidMatchOnIngestJobData,
  logger: Logger,
): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(braidIdentities)
      .set({ needs_rescan: true })
      .where(
        and(
          eq(braidIdentities.source_type, data.source_type),
          eq(braidIdentities.source_id, data.source_id),
          sql`${braidIdentities.organization_id} IS NOT NULL`,
        ),
      );
    logger.warn({ source_type: data.source_type, source_id: data.source_id }, 'braid-match-on-ingest: DLQ, flagged needs_rescan');
  } catch (err) {
    logger.error({ err, data }, 'braid-match-on-ingest: DLQ handler failed');
  }
}
