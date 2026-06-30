/**
 * Blip retention + purge sweep (Blip §11.2).
 *
 * Two enforcement mechanisms, chosen for cost:
 *
 *   1. Coarse floor (cheap): drop whole monthly partitions once every row in
 *      them is past the LONGEST retention in force. Bulk path; the reason for
 *      time-partitioning. Skipped entirely if any policy has no age limit
 *      (max_age_days NULL = "keep forever"), because partitions are shared
 *      across orgs/apps and a partition drop is global.
 *   2. Finer per-(app, report_type) policies (bounded): batched ranged deletes
 *      within live partitions for report types whose retention is shorter than
 *      the partition floor.
 *
 * Partition drops do not cascade to object storage, so before each destructive
 * step the referenced capture objects are listed and deleted (bounded). Capture
 * objects are month-keyed (<org>/blip/<app>/<YYYY-MM>/...) so a month drop pairs
 * with a per-(org, app) prefix sweep of that month.
 *
 * Emits entries.purged with counts. Defensive and idempotent throughout: every
 * step tolerates re-runs and partial completion.
 *
 * NOTE / TODO: max_rows / max_bytes cap enforcement (delete-oldest-beyond-cap)
 * is described in §11.2 but not yet implemented here; only max_age_days age
 * limits are enforced. Tracked as a follow-up.
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { listObjectKeys, removeObject } from '../utils/storage.js';

export interface BlipRetentionSweepJobData {
  /** Max rows deleted per ranged-delete batch. Defaults to 5000. */
  batchSize?: number;
  /** Max ranged-delete batches per (app, type) per run. Defaults to 20. */
  maxBatches?: number;
}

interface PolicyRow {
  org_id: string;
  tracked_app_id: string;
  report_type: string | null;
  max_age_days: number | null;
}

interface TrackedAppRow {
  id: string;
  org_id: string;
}

interface CaptureRow {
  payload: { screen_captures?: Array<{ object_key?: string; thumb_key?: string }> };
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** List monthly partitions of blip_entries with their upper-bound date. */
async function listMonthPartitions(
  db: ReturnType<typeof getDb>,
): Promise<Array<{ name: string; toDate: Date }>> {
  // pg_get_expr renders the partition bound, e.g.
  //   FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00')
  const raw = await db.execute(sql`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'blip_entries'
  `);
  const out: Array<{ name: string; toDate: Date }> = [];
  for (const r of rows<{ name: string; bound: string }>(raw)) {
    const m = /TO \('([^']+)'\)/.exec(r.bound ?? '');
    const toRaw = m?.[1];
    if (!toRaw) continue; // DEFAULT partition has no TO bound — never age-droppable.
    const d = new Date(toRaw);
    if (!Number.isNaN(d.getTime())) out.push({ name: r.name, toDate: d });
  }
  return out;
}

/** Delete every capture object stored under one (org, app, month) prefix. */
async function gcMonthCaptures(
  orgId: string,
  trackedAppId: string,
  monthSeg: string,
  logger: Logger,
): Promise<number> {
  const prefix = `${orgId}/blip/${trackedAppId}/${monthSeg}/`;
  const keys = await listObjectKeys(prefix);
  for (const k of keys) await removeObject(k);
  if (keys.length > 0) {
    logger.info({ prefix, deleted: keys.length }, 'blip-retention: month capture GC');
  }
  return keys.length;
}

export async function processBlipRetentionSweepJob(
  job: Job<BlipRetentionSweepJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const batchSize = job.data?.batchSize ?? 5000;
  const maxBatches = job.data?.maxBatches ?? 20;

  const policies = rows<PolicyRow>(
    await db.execute(sql`
      SELECT org_id, tracked_app_id, report_type, max_age_days
      FROM blip_retention_policies
    `),
  );
  if (policies.length === 0) {
    logger.debug('blip-retention: no policies');
    return;
  }

  const apps = rows<TrackedAppRow>(
    await db.execute(sql`SELECT id, org_id FROM blip_tracked_apps`),
  );

  let partitionsDropped = 0;
  let imagesDeleted = 0;
  let rowsDeleted = 0;

  // ---- 1) Coarse floor: drop whole month partitions past the longest age ----
  const anyUnbounded = policies.some((p) => p.max_age_days == null);
  const longest = policies.reduce(
    (max, p) => (p.max_age_days != null && p.max_age_days > max ? p.max_age_days : max),
    0,
  );
  if (!anyUnbounded && longest > 0) {
    const floor = new Date(Date.now() - longest * 86_400_000);
    const partitions = await listMonthPartitions(db);
    for (const part of partitions) {
      // Every row in this partition is older than its upper bound; if that bound
      // is at/below the floor, the whole month is past the longest retention.
      if (part.toDate.getTime() > floor.getTime()) continue;

      // Pair the drop with a per-(org, app) image prefix sweep for that month.
      // Partition name is blip_entries_YYYY_MM -> month segment YYYY-MM.
      const m = /blip_entries_(\d{4})_(\d{2})$/.exec(part.name);
      if (m) {
        const monthSeg = `${m[1]}-${m[2]}`;
        for (const app of apps) {
          imagesDeleted += await gcMonthCaptures(app.org_id, app.id, monthSeg, logger);
        }
      }
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${part.name}`));
      partitionsDropped += 1;
      logger.info({ partition: part.name }, 'blip-retention: dropped month partition');
    }
  }

  // ---- 2) Finer per-(app, report_type) ranged deletes ----
  // Group policies per app: the default (report_type null) and per-type overrides.
  const byApp = new Map<string, { org_id: string; def: number | null; overrides: Map<string, number | null> }>();
  for (const p of policies) {
    let g = byApp.get(p.tracked_app_id);
    if (!g) {
      g = { org_id: p.org_id, def: null, overrides: new Map() };
      byApp.set(p.tracked_app_id, g);
    }
    if (p.report_type == null) g.def = p.max_age_days;
    else g.overrides.set(p.report_type, p.max_age_days);
  }

  for (const [appId, g] of byApp) {
    // Per-type overrides with an age limit.
    for (const [reportType, maxAge] of g.overrides) {
      if (maxAge == null) continue;
      const cutoff = new Date(Date.now() - maxAge * 86_400_000);
      rowsDeleted += await rangedDelete(db, appId, reportType, null, cutoff, batchSize, maxBatches, logger);
    }
    // App-wide default: delete old rows EXCEPT report types with their own override
    // (an override may be longer than the default and must protect those rows).
    if (g.def != null) {
      const cutoff = new Date(Date.now() - g.def * 86_400_000);
      const excluded = [...g.overrides.keys()];
      rowsDeleted += await rangedDelete(db, appId, null, excluded, cutoff, batchSize, maxBatches, logger);
    }
  }

  if (partitionsDropped > 0 || rowsDeleted > 0) {
    // One summary purge event per sweep (best-effort; org-level fan-out is fine
    // at the platform grain since a sweep spans orgs).
    await publishBoltEvent(
      'entries.purged',
      'blip',
      {
        reason: 'retention',
        partitions_dropped: partitionsDropped,
        rows_deleted: rowsDeleted,
        images_deleted: imagesDeleted,
      },
      // No single org owns a cross-org sweep; use the first app's org if present.
      apps[0]?.org_id ?? '00000000-0000-0000-0000-000000000000',
    );
  }

  logger.info(
    { jobId: job.id, partitionsDropped, rowsDeleted, imagesDeleted },
    'blip-retention: sweep complete',
  );
}

/**
 * Bounded, looped ranged delete for one (app[, report_type]) older than cutoff.
 * Deletes capture objects of capture-bearing rows before removing the rows.
 * Returns the number of rows deleted.
 */
async function rangedDelete(
  db: ReturnType<typeof getDb>,
  appId: string,
  reportType: string | null,
  excludeTypes: string[] | null,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
  logger: Logger,
): Promise<number> {
  let total = 0;
  const cutoffIso = cutoff.toISOString();

  for (let batch = 0; batch < maxBatches; batch++) {
    // Select the next batch of victim PKs.
    const typeClause =
      reportType != null
        ? sql`AND report_type = ${reportType}`
        : excludeTypes && excludeTypes.length > 0
          ? sql`AND report_type <> ALL(${excludeTypes})`
          : sql``;

    const victims = rows<{ received_at: string; id: string; capture_count: number }>(
      await db.execute(sql`
        SELECT received_at, id, capture_count
        FROM blip_entries
        WHERE tracked_app_id = ${appId}
          AND received_at < ${cutoffIso}::timestamptz
          ${typeClause}
        ORDER BY received_at ASC
        LIMIT ${batchSize}
      `),
    );
    if (victims.length === 0) break;

    // GC captures for capture-bearing victims first (bounded to this batch).
    const captureVictims = victims.filter((v) => v.capture_count > 0);
    if (captureVictims.length > 0) {
      const refRows = rows<CaptureRow>(
        await db.execute(sql`
          SELECT payload FROM blip_entries
          WHERE (received_at, id) IN (
            ${sql.join(
              captureVictims.map((v) => sql`(${v.received_at}::timestamptz, ${v.id}::uuid)`),
              sql`, `,
            )}
          )
        `),
      );
      for (const r of refRows) {
        const caps = r.payload?.screen_captures;
        if (!Array.isArray(caps)) continue;
        for (const c of caps) {
          if (c?.object_key) await removeObject(c.object_key);
          if (c?.thumb_key) await removeObject(c.thumb_key);
        }
      }
    }

    await db.execute(sql`
      DELETE FROM blip_entries
      WHERE (received_at, id) IN (
        ${sql.join(
          victims.map((v) => sql`(${v.received_at}::timestamptz, ${v.id}::uuid)`),
          sql`, `,
        )}
      )
    `);
    total += victims.length;

    if (victims.length < batchSize) break; // drained
  }

  if (total > 0) {
    logger.info(
      { appId, reportType: reportType ?? '(default)', deleted: total },
      'blip-retention: ranged delete',
    );
  }
  return total;
}
