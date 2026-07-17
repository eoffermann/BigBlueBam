import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { basisMetrics, basisMetricVersions } from '../db/schema/index.js';
import type { CreateBasisMetricInput, UpdateBasisMetricInput } from '@bigbluebam/shared';

export interface ListMetricsOptions {
  certification?: string;
  limit: number;
}

export async function listMetrics(orgId: string, opts: ListMetricsOptions) {
  const conditions = [eq(basisMetrics.organization_id, orgId)];
  if (opts.certification) {
    conditions.push(eq(basisMetrics.certification, opts.certification));
  }
  return db
    .select()
    .from(basisMetrics)
    .where(and(...conditions))
    .orderBy(desc(basisMetrics.updated_at))
    .limit(opts.limit);
}

export async function getMetric(orgId: string, id: string) {
  const [metric] = await db
    .select()
    .from(basisMetrics)
    .where(and(eq(basisMetrics.id, id), eq(basisMetrics.organization_id, orgId)))
    .limit(1);
  if (!metric) return null;

  let currentVersion = null;
  if (metric.current_version_id) {
    const [v] = await db
      .select()
      .from(basisMetricVersions)
      .where(eq(basisMetricVersions.id, metric.current_version_id))
      .limit(1);
    currentVersion = v ?? null;
  }
  return { metric, currentVersion };
}

// Create a draft metric plus its first immutable version, in one transaction.
export async function createMetric(
  orgId: string,
  userId: string,
  input: CreateBasisMetricInput,
) {
  return db.transaction(async (tx) => {
    const [metricRow] = await tx
      .insert(basisMetrics)
      .values({
        organization_id: orgId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        unit: input.unit,
        favorable_direction: input.favorable_direction,
        owner_id: input.owner_id ?? null,
        certification: 'draft',
        related_apps: input.related_apps ?? input.lineage?.apps ?? [],
        target: input.target ?? null,
        created_by: userId,
      })
      .returning();
    if (!metricRow) throw new Error('basis metric insert returned no row');

    const [version] = await tx
      .insert(basisMetricVersions)
      .values({
        metric_id: metricRow.id,
        organization_id: orgId,
        version_number: 1,
        definition: input.definition,
        lineage: input.lineage ?? { apps: [] },
        change_note: input.change_note ?? null,
        created_by: userId,
      })
      .returning();
    if (!version) throw new Error('basis metric version insert returned no row');

    const [updated] = await tx
      .update(basisMetrics)
      .set({ current_version_id: version.id, updated_at: new Date() })
      .where(eq(basisMetrics.id, metricRow.id))
      .returning();

    return { metric: updated ?? metricRow, currentVersion: version };
  });
}

export async function updateMetricMetadata(
  orgId: string,
  id: string,
  input: UpdateBasisMetricInput,
) {
  const patch: Record<string, unknown> = { updated_at: new Date() };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) patch[k] = v;
  }
  const [updated] = await db
    .update(basisMetrics)
    .set(patch)
    .where(and(eq(basisMetrics.id, id), eq(basisMetrics.organization_id, orgId)))
    .returning();
  return updated ?? null;
}

// Guard used before a create so a duplicate slug returns a clean 409 rather than
// a raw unique-violation.
export async function slugExists(orgId: string, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(basisMetrics)
    .where(and(eq(basisMetrics.organization_id, orgId), eq(basisMetrics.slug, slug)))
    .limit(1);
  return !!row;
}
