/**
 * Basis metric snapshot capture (Basis design spec section 6).
 *
 * For each certified metric, capture its value at a bucket-aligned timestamp and
 * INSERT ON CONFLICT DO UPDATE (idempotent: a retried tick re-derives the same
 * captured_at boundary and no-ops). Values come from Bench's internal governed
 * query route (mode b: INTERNAL_SERVICE_SECRET + explicit org_id). Each
 * (org, metric) is wrapped in try/catch log-and-continue; a drifted definition
 * sets resolve_status='resolve_failed' instead of aborting the sweep.
 *
 * Snapshot window: the trailing period ending at the bucket boundary, length
 * matched to the grain (hour -> 1h, day -> 30d) so a flow (sum/count) metric has
 * a meaningful "current value" and a stock metric reads its latest state.
 */
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface BasisMetricSnapshotJobData {
  grain?: 'hour' | 'day';
}

interface MetricRow {
  id: string;
  organization_id: string;
  version_id: string;
  definition: {
    source_product: string;
    source_entity: string;
    measure: { field: string; agg: string };
    filters?: { field: string; op: string; value: unknown }[];
    time_column: string;
  };
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

async function benchScalar(orgId: string, m: MetricRow, from: Date, to: Date): Promise<number | null> {
  const url = `${(process.env.BENCH_API_INTERNAL_URL ?? 'http://bench-api:4011').replace(/\/+$/, '')}/internal/query`;
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new Error('INTERNAL_SERVICE_SECRET not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
    body: JSON.stringify({
      product: m.definition.source_product,
      entity: m.definition.source_entity,
      org_id: orgId,
      config: {
        measures: [{ field: m.definition.measure.field, agg: m.definition.measure.agg, alias: 'value' }],
        filters: m.definition.filters?.map((f) => ({ field: f.field, op: f.op, value: f.value })),
        time_dimension: { field: m.definition.time_column, granularity: 'day' },
        date_range: { start: from.toISOString(), end: to.toISOString() },
      },
    }),
  });
  if (!res.ok) throw new Error(`bench query ${res.status}`);
  const json = (await res.json()) as { data?: { rows?: { value?: unknown }[] } };
  const v = json.data?.rows?.[0]?.value;
  return v == null ? null : Number(v);
}

export async function processBasisMetricSnapshotJob(
  job: Job<BasisMetricSnapshotJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const grain = job.data?.grain ?? 'hour';
  const start = Date.now();

  // Bucket-align captured_at to the grain boundary in UTC (re-derived from the
  // tick, never now()), so ON CONFLICT makes a retry a no-op.
  const now = new Date();
  const capturedAt = new Date(now);
  capturedAt.setUTCMinutes(0, 0, 0);
  if (grain === 'day') capturedAt.setUTCHours(0);
  const windowMs = grain === 'day' ? 30 * 86400_000 : 3600_000;
  const from = new Date(capturedAt.getTime() - windowMs);

  const metrics = rows<MetricRow>(
    await db.execute(sql`
      SELECT m.id, m.organization_id, m.current_version_id AS version_id, v.definition
      FROM basis_metrics m
      JOIN basis_metric_versions v ON v.id = m.current_version_id
      WHERE m.certification = 'certified'
    `),
  );

  let captured = 0;
  let failed = 0;
  for (const m of metrics) {
    try {
      const value = await benchScalar(m.organization_id, m, from, capturedAt);
      if (value == null) continue;
      await db.execute(sql`
        INSERT INTO basis_metric_snapshots (metric_id, organization_id, version_id, captured_at, grain, value)
        VALUES (${m.id}, ${m.organization_id}, ${m.version_id}, ${capturedAt.toISOString()}, ${grain}, ${value})
        ON CONFLICT (metric_id, grain, captured_at, version_id) DO UPDATE SET value = EXCLUDED.value
      `);
      captured++;
    } catch (err) {
      failed++;
      // Drifted definition / bench error: mark resolve_failed, keep going.
      await db
        .execute(sql`
          UPDATE basis_metrics
          SET resolve_status = 'resolve_failed', resolve_failed_at = now()
          WHERE id = ${m.id}
        `)
        .catch(() => {});
      logger.warn(
        { jobId: job.id, metricId: m.id, err: (err as Error).message },
        'basis-metric-snapshot: metric failed, continuing',
      );
    }
    if ((captured + failed) % 25 === 0) {
      logger.info({ processed: captured + failed, total: metrics.length }, 'basis-metric-snapshot: progress');
    }
  }

  logger.info(
    { jobId: job.id, grain, captured, failed, total: metrics.length, durationMs: Date.now() - start },
    'basis-metric-snapshot: done',
  );
}
