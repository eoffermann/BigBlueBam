import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { basisMetrics, basisMetricVersions, basisExplanations } from '../db/schema/index.js';
import type { BasisDefinition, BasisExplainRequest } from '@bigbluebam/shared';
import { queryScalar, queryGrouped } from '../lib/bench-client.js';
import { getSettings } from './settings.service.js';
import { classifyDimension, computeDrivers, shapeForRead } from './explain-math.js';

// Pure decomposition + leak-safety helpers live in explain-math.ts (no db/env
// imports) so the spec section 9 invariants are unit-testable. Re-export the ones
// other modules/tests consume.
export { classifyDimension, computeDrivers, shapeForRead } from './explain-math.js';

function cacheKey(
  metricId: string,
  versionId: string,
  a: { from: string; to: string },
  b: { from: string; to: string },
  dim: string,
): string {
  const tuple = JSON.stringify([metricId, versionId, a.from, a.to, b.from, b.to, dim]);
  return createHash('sha256').update(tuple).digest('hex').slice(0, 64);
}

interface LoadedMetric {
  metric: typeof basisMetrics.$inferSelect;
  version: typeof basisMetricVersions.$inferSelect;
  def: BasisDefinition;
}

async function loadCurrent(orgId: string, metricId: string): Promise<LoadedMetric | null> {
  const [metric] = await db
    .select()
    .from(basisMetrics)
    .where(and(eq(basisMetrics.id, metricId), eq(basisMetrics.organization_id, orgId)))
    .limit(1);
  if (!metric?.current_version_id) return null;
  const [version] = await db
    .select()
    .from(basisMetricVersions)
    .where(eq(basisMetricVersions.id, metric.current_version_id))
    .limit(1);
  if (!version) return null;
  return { metric, version, def: version.definition as BasisDefinition };
}

export async function getValue(
  orgId: string,
  metricId: string,
  period: { from: string; to: string },
): Promise<{ value: number | null; unit: string } | null> {
  const loaded = await loadCurrent(orgId, metricId);
  if (!loaded) return null;
  const value = await queryScalar(orgId, loaded.def, period);
  return { value, unit: loaded.metric.unit };
}

// Resolve the effective decomposition dimension: request > default_dimensions[0]
// > org Settings default. Returns null if none is resolvable.
async function resolveDimension(
  orgId: string,
  requested: string | undefined,
  def: BasisDefinition,
): Promise<string | null> {
  if (requested) return requested;
  if (def.default_dimensions?.length) return def.default_dimensions[0]!;
  const settings = await getSettings(orgId);
  return settings.default_dimension;
}

export async function explain(orgId: string, metricId: string, req: BasisExplainRequest) {
  const loaded = await loadCurrent(orgId, metricId);
  if (!loaded) return { notFound: true as const };

  const dimension = await resolveDimension(orgId, req.dimension, loaded.def);
  if (!dimension) return { noDimension: true as const };

  const key = cacheKey(metricId, loaded.version.id, req.period_a, req.period_b, dimension);
  const dimClass = classifyDimension(dimension);

  // Cache hit within TTL -> serve deterministic row (correlation is per-user and
  // added at read time; not cached).
  const settings = await getSettings(orgId);
  const [cached] = await db
    .select()
    .from(basisExplanations)
    .where(eq(basisExplanations.cache_key, key))
    .limit(1);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.computed_at).getTime();
    if (ageMs < settings.explanation_cache_ttl_seconds * 1000) {
      return { explanation: shapeForRead(cached, dimClass) };
    }
  }

  // Deterministic dimensional decomposition: value_B(g) - value_A(g).
  const [aMap, bMap] = await Promise.all([
    queryGrouped(orgId, loaded.def, dimension, req.period_a),
    queryGrouped(orgId, loaded.def, dimension, req.period_b),
  ]);
  const { drivers, deltaAbs, deltaPct } = computeDrivers(aMap, bMap, dimClass);

  await db
    .insert(basisExplanations)
    .values({
      metric_id: metricId,
      organization_id: orgId,
      version_id: loaded.version.id,
      cache_key: key,
      period_a: req.period_a,
      period_b: req.period_b,
      dimension,
      dimension_class: dimClass,
      delta_abs: String(deltaAbs),
      delta_pct: deltaPct == null ? null : String(deltaPct),
      drivers,
      // Class B never gets a shared narrative; Class A narrative is added by the
      // (LLM) worker path, null until then.
      narrative: null,
    })
    .onConflictDoUpdate({
      target: basisExplanations.cache_key,
      set: {
        drivers,
        delta_abs: String(deltaAbs),
        delta_pct: deltaPct == null ? null : String(deltaPct),
        computed_at: new Date(),
      },
    });

  const [stored] = await db
    .select()
    .from(basisExplanations)
    .where(eq(basisExplanations.cache_key, key))
    .limit(1);
  return { explanation: shapeForRead(stored!, dimClass) };
}
