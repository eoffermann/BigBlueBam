import { and, desc, eq, sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { basisMetrics, basisMetricVersions } from '../db/schema/index.js';
import type {
  CreateBasisMetricInput,
  CreateBasisVersionInput,
  UpdateBasisMetricInput,
} from '@bigbluebam/shared';

// Bolt event helper (source 'basis'). Fire-and-forget; never breaks the op.
function emit(
  eventType: string,
  payload: Record<string, unknown>,
  orgId: string,
  actorId?: string,
) {
  void publishBoltEvent(eventType, 'basis', payload, orgId, actorId);
}

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
  const created = await db.transaction(async (tx) => {
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

  emit(
    'metric.created',
    { metric: { id: created.metric.id, slug: created.metric.slug, name: created.metric.name } },
    orgId,
    userId,
  );
  return created;
}

// New immutable version + set as current. Emits metric.definition_changed.
// The route/MCP layer enforces HITL (Redis confirm token) for versioning a
// CERTIFIED metric; this service performs the write.
export async function addVersion(
  orgId: string,
  userId: string,
  metricId: string,
  input: CreateBasisVersionInput,
) {
  const result = await db.transaction(async (tx) => {
    const [metric] = await tx
      .select()
      .from(basisMetrics)
      .where(and(eq(basisMetrics.id, metricId), eq(basisMetrics.organization_id, orgId)))
      .limit(1);
    if (!metric) return null;

    const maxRows = await tx
      .select({ maxNum: sql<number>`coalesce(max(${basisMetricVersions.version_number}), 0)` })
      .from(basisMetricVersions)
      .where(eq(basisMetricVersions.metric_id, metricId));
    const nextNumber = Number(maxRows[0]?.maxNum ?? 0) + 1;

    const [version] = await tx
      .insert(basisMetricVersions)
      .values({
        metric_id: metricId,
        organization_id: orgId,
        version_number: nextNumber,
        definition: input.definition,
        lineage: input.lineage ?? { apps: [] },
        change_note: input.change_note ?? null,
        created_by: userId,
      })
      .returning();
    if (!version) throw new Error('version insert returned no row');

    await tx
      .update(basisMetrics)
      .set({ current_version_id: version.id, updated_at: new Date() })
      .where(eq(basisMetrics.id, metricId));

    return { metric, version };
  });
  if (!result) return null;
  emit(
    'metric.definition_changed',
    { metric: { id: metricId }, version: { number: result.version.version_number, change_note: result.version.change_note } },
    orgId,
    userId,
  );
  return result.version;
}

export async function listVersions(orgId: string, metricId: string) {
  return db
    .select()
    .from(basisMetricVersions)
    .where(
      and(
        eq(basisMetricVersions.metric_id, metricId),
        eq(basisMetricVersions.organization_id, orgId),
      ),
    )
    .orderBy(desc(basisMetricVersions.version_number));
}

// Certification state transitions. Each emits its Bolt event.
async function setCertification(
  orgId: string,
  userId: string,
  metricId: string,
  next: 'draft' | 'certified' | 'deprecated',
  eventType: string,
) {
  const [updated] = await db
    .update(basisMetrics)
    .set({ certification: next, updated_at: new Date() })
    .where(and(eq(basisMetrics.id, metricId), eq(basisMetrics.organization_id, orgId)))
    .returning();
  if (!updated) return null;
  emit(eventType, { metric: { id: metricId } }, orgId, userId);
  return updated;
}

export const certifyMetric = (orgId: string, userId: string, id: string) =>
  setCertification(orgId, userId, id, 'certified', 'metric.certified');
export const decertifyMetric = (orgId: string, userId: string, id: string) =>
  setCertification(orgId, userId, id, 'draft', 'metric.decertified');
export const deprecateMetric = (orgId: string, userId: string, id: string) =>
  setCertification(orgId, userId, id, 'deprecated', 'metric.deprecated');

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
