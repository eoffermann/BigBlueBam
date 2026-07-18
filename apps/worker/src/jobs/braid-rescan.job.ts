/**
 * Braid nightly rescan (Braid design spec §4.6, ST-r2-3/ST-r2-7). Daily cron '20 3 * * *'.
 *
 * Source-diffs each enabled source type per org and re-enqueues braid-match-on-ingest jobs:
 *   (a) changed-since: source rows where source.updated_at > braid_identities.source_synced_at
 *       (catches in-place edits, where the source mutation bumps updated_at, spec ST3-3);
 *   (b) left-anti-join: source rows with NO identity yet (the outage backfill);
 *   (c) needs_rescan DLQ give-ups.
 * It also reconciles the transactional outbox: re-publishes profile.* events where
 * last_event_published_at lags updated_at, stamping each marker to the OBSERVED updated_at
 * (never now(), spec ST3-1). Qdrant re-embed reconcile is a documented M6 TODO (embedding
 * recall is the soft dependency; the merge path left it stale too).
 *
 * LIMIT'd cursor batches with a per-tick cap; last_rescan_at is advanced per org only after
 * a fully-successful (uncapped) pass, so a mid-tick stop is resumable from the per-identity
 * source_synced_at / needs_rescan high-water. Progress logged every 25%.
 * Modeled on basis-metric-snapshot.job.ts.
 */

import type { Job } from 'bullmq';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BraidMatchOnIngestJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';

export interface BraidRescanJobData {
  /** Optional: scope to a single org for targeted runs. */
  organization_id?: string;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

const BATCH = 500;
const MAX_ENQUEUE_PER_TICK = 20000;

// Per-source SQL fragments. book.event_attendee derives org via its parent event and has no
// deleted_at; the bond sources carry a soft-delete column.
interface SourceCfg {
  table: string;
  orgFilter: (org: string) => ReturnType<typeof sql>;
  notDeleted: ReturnType<typeof sql>;
}

const SOURCE_CFG: Record<string, SourceCfg> = {
  'bond.contact': {
    table: 'bond_contacts',
    orgFilter: (org) => sql`src.organization_id = ${org}`,
    notDeleted: sql`src.deleted_at IS NULL`,
  },
  'bond.company': {
    table: 'bond_companies',
    orgFilter: (org) => sql`src.organization_id = ${org}`,
    notDeleted: sql`src.deleted_at IS NULL`,
  },
  'bill.client': {
    table: 'bill_clients',
    orgFilter: (org) => sql`src.organization_id = ${org}`,
    notDeleted: sql`TRUE`,
  },
  'helpdesk.user': {
    table: 'helpdesk_users',
    orgFilter: (org) => sql`src.org_id = ${org}`,
    notDeleted: sql`TRUE`,
  },
};

async function enqueue(
  queue: Queue<BraidMatchOnIngestJobData>,
  org: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  // Idempotent jobId collapses duplicate enqueues for the same (org, type, id) within the
  // BullMQ retention window, so a live dispatch + the nightly diff do not double-run.
  await queue.add(
    'ingest',
    { org_id: org, source_type: sourceType, source_id: sourceId },
    {
      jobId: `braid:${org}:${sourceType}:${sourceId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    },
  );
}

export async function processBraidRescanJob(
  job: Job<BraidRescanJobData>,
  queue: Queue<BraidMatchOnIngestJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const started = Date.now();
  const scopeOrg = job.data?.organization_id;

  // Orgs to sweep: those with braid_org_settings (thresholds + enabled sources) plus any org
  // that already has braid identities (settings row may be absent).
  const orgRows = rows<{ organization_id: string; enabled_source_types: unknown }>(
    await db.execute(sql`
      SELECT s.organization_id, s.enabled_source_types
        FROM braid_org_settings s
       ${scopeOrg ? sql`WHERE s.organization_id = ${scopeOrg}` : sql``}
    `),
  );

  logger.info({ jobId: job.id, orgs: orgRows.length, scopeOrg }, 'braid-rescan: starting');

  let enqueued = 0;
  let orgsDone = 0;
  let capped = false;
  const total = orgRows.length || 1;
  let nextLogPct = 25;

  for (const org of orgRows) {
    const enabled = Array.isArray(org.enabled_source_types) ? (org.enabled_source_types as string[]) : [];
    let orgFullyProcessed = true;

    // (c) needs_rescan DLQ give-ups first (cheapest to clear).
    if (enqueued < MAX_ENQUEUE_PER_TICK) {
      const dlq = rows<{ source_type: string; source_id: string }>(
        await db.execute(sql`
          SELECT source_type, source_id FROM braid_identities
           WHERE organization_id = ${org.organization_id} AND needs_rescan
           LIMIT ${BATCH}
        `),
      );
      for (const r of dlq) {
        if (enqueued >= MAX_ENQUEUE_PER_TICK) { capped = true; orgFullyProcessed = false; break; }
        await enqueue(queue, org.organization_id, r.source_type, r.source_id);
        enqueued += 1;
      }
      if (dlq.length === BATCH) orgFullyProcessed = false; // more remain than one batch
    }

    for (const sourceType of enabled) {
      const cfg = SOURCE_CFG[sourceType];
      if (!cfg) {
        // book.event_attendee (org-via-parent) handled below; unknown types skipped.
        if (sourceType !== 'book.event_attendee') continue;
      }
      if (enqueued >= MAX_ENQUEUE_PER_TICK) { capped = true; orgFullyProcessed = false; break; }

      const ids =
        sourceType === 'book.event_attendee'
          ? await diffBookAttendees(db, org.organization_id)
          : await diffGenericSource(db, org.organization_id, sourceType, cfg!);

      for (const id of ids) {
        if (enqueued >= MAX_ENQUEUE_PER_TICK) { capped = true; orgFullyProcessed = false; break; }
        await enqueue(queue, org.organization_id, sourceType, id);
        enqueued += 1;
      }
      if (ids.length >= BATCH * 2) orgFullyProcessed = false; // batch ceiling hit; more remain
    }

    // (outbox) re-publish profile.* events whose marker lags updated_at.
    if (!capped) {
      await reconcileOutbox(db, org.organization_id, logger);
    }

    // Advance last_rescan_at only after a fully-successful (uncapped) org pass (spec ST-r2-7).
    if (orgFullyProcessed && !capped) {
      await db.execute(sql`
        UPDATE braid_org_settings SET last_rescan_at = now()
         WHERE organization_id = ${org.organization_id}
      `);
    }

    orgsDone += 1;
    const pct = Math.floor((orgsDone / total) * 100);
    if (pct >= nextLogPct) {
      logger.info({ jobId: job.id, orgsDone, total, enqueued, pct }, 'braid-rescan: progress');
      nextLogPct += 25;
    }
    if (capped) break;
  }

  logger.info(
    { jobId: job.id, orgsDone, enqueued, capped, elapsedMs: Date.now() - started },
    'braid-rescan: done',
  );
}

// Generic changed-since + anti-join for org-scoped sources with an updated_at column.
async function diffGenericSource(
  db: ReturnType<typeof getDb>,
  org: string,
  sourceType: string,
  cfg: SourceCfg,
): Promise<string[]> {
  const changed = rows<{ id: string }>(
    await db.execute(sql`
      SELECT src.id
        FROM ${sql.raw(cfg.table)} src
        JOIN braid_identities bi
          ON bi.organization_id = ${org}
         AND bi.source_type = ${sourceType}
         AND bi.source_id = src.id
       WHERE ${cfg.orgFilter(org)}
         AND ${cfg.notDeleted}
         AND (bi.source_synced_at IS NULL OR src.updated_at > bi.source_synced_at)
       LIMIT ${BATCH}
    `),
  );
  const missing = rows<{ id: string }>(
    await db.execute(sql`
      SELECT src.id
        FROM ${sql.raw(cfg.table)} src
        LEFT JOIN braid_identities bi
          ON bi.organization_id = ${org}
         AND bi.source_type = ${sourceType}
         AND bi.source_id = src.id
       WHERE ${cfg.orgFilter(org)}
         AND ${cfg.notDeleted}
         AND bi.id IS NULL
       LIMIT ${BATCH}
    `),
  );
  return dedupe([...changed, ...missing].map((r) => r.id));
}

// book.event_attendee derives org via book_events; no deleted_at.
async function diffBookAttendees(db: ReturnType<typeof getDb>, org: string): Promise<string[]> {
  const changed = rows<{ id: string }>(
    await db.execute(sql`
      SELECT src.id
        FROM book_event_attendees src
        JOIN book_events ev ON ev.id = src.event_id
        JOIN braid_identities bi
          ON bi.organization_id = ${org}
         AND bi.source_type = 'book.event_attendee'
         AND bi.source_id = src.id
       WHERE ev.organization_id = ${org}
         AND (bi.source_synced_at IS NULL OR src.updated_at > bi.source_synced_at)
       LIMIT ${BATCH}
    `),
  );
  const missing = rows<{ id: string }>(
    await db.execute(sql`
      SELECT src.id
        FROM book_event_attendees src
        JOIN book_events ev ON ev.id = src.event_id
        LEFT JOIN braid_identities bi
          ON bi.organization_id = ${org}
         AND bi.source_type = 'book.event_attendee'
         AND bi.source_id = src.id
       WHERE ev.organization_id = ${org}
         AND bi.id IS NULL
       LIMIT ${BATCH}
    `),
  );
  return dedupe([...changed, ...missing].map((r) => r.id));
}

// Re-publish profile.merged for merged/multi-member profiles whose outbox marker lags the
// golden record's updated_at (a lost post-commit publish), then stamp the marker to the
// OBSERVED updated_at (spec ST3-1). Lone singletons (identity_count <= 1) never had a merge
// event so are intentionally excluded to avoid spurious frames.
async function reconcileOutbox(db: ReturnType<typeof getDb>, org: string, logger: Logger): Promise<void> {
  const lagging = rows<{ id: string; updated_at: string | Date; identity_count: number }>(
    await db.execute(sql`
      SELECT id, updated_at, identity_count FROM braid_profiles
       WHERE organization_id = ${org}
         AND status = 'active'
         AND identity_count > 1
         AND (last_event_published_at IS NULL OR last_event_published_at < updated_at)
       LIMIT ${BATCH}
    `),
  );
  for (const p of lagging) {
    const members = rows<{ source_type: string; source_id: string }>(
      await db.execute(sql`
        SELECT source_type, source_id FROM braid_identities
         WHERE organization_id = ${org} AND profile_id = ${p.id}
      `),
    );
    const observed = p.updated_at instanceof Date ? p.updated_at : new Date(p.updated_at);
    await publishBoltEvent(
      'profile.merged',
      'braid',
      {
        profile: { id: p.id },
        affected_identities: members,
        identity_count: p.identity_count,
        decision_kind: 'auto',
      },
      org,
      undefined,
      'system',
    );
    // Stamp to the OBSERVED updated_at, guarded so a concurrent bump is not masked.
    await db.execute(sql`
      UPDATE braid_profiles SET last_event_published_at = ${observed.toISOString()}
       WHERE id = ${p.id} AND updated_at = ${observed.toISOString()}
    `);
  }
  if (lagging.length > 0) {
    logger.info({ org, reconciled: lagging.length }, 'braid-rescan: outbox re-published');
  }
  // TODO(M6+): Qdrant re-embed reconcile (qdrant_synced_at lag) once identity embedding
  // lands; the merge path likewise leaves qdrant_synced_at stale by design.
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}
