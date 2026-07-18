import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { basisMetrics, basisMetricVersions, basisExplanations } from '../db/schema/index.js';
import type { BasisDefinition, BasisExplainRequest, BasisDriver } from '@bigbluebam/shared';
import { queryScalar, queryGrouped } from '../lib/bench-client.js';
import { getSettings } from './settings.service.js';

// Class-A: a CURATED allowlist of bounded org-global ENUM columns whose values
// are not per-user-restricted (spec 2.2). Deliberately narrow: generic names like
// `type`/`category`/`kind` are NOT included, because a governed source could
// expose a sensitive or high-cardinality column under such a name and it would
// then serve full per-value labels + amounts (security review #55). Anything not
// on this list is Class-B (entity-derived) and fails closed until the per-user
// can_access resolver is wired. Extend this set only with columns confirmed to be
// bounded, org-global enums.
const CLASS_A_DIMENSIONS = new Set([
  'status',
  'stage',
  'state',
  'lifecycle_stage',
  'level',
  'priority',
]);

function classifyDimension(dim: string): 'A' | 'B' {
  return CLASS_A_DIMENSIONS.has(dim) ? 'A' : 'B';
}

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
  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  const rawDrivers: { dimension_value: string; contribution_abs: number }[] = [];
  let totalA = 0;
  let totalB = 0;
  for (const g of keys) {
    const av = aMap.get(g) ?? 0;
    const bv = bMap.get(g) ?? 0;
    totalA += av;
    totalB += bv;
    rawDrivers.push({ dimension_value: g, contribution_abs: bv - av });
  }
  const deltaAbs = totalB - totalA;
  const deltaPct = totalA !== 0 ? (deltaAbs / totalA) * 100 : null;
  rawDrivers.sort((x, y) => Math.abs(y.contribution_abs) - Math.abs(x.contribution_abs));

  const drivers = rawDrivers.map((d) => ({
    dimension_value: d.dimension_value,
    // Class A carries a concrete label (the value is a bounded org-global enum);
    // Class B stores the opaque value only.
    label: dimClass === 'A' ? d.dimension_value : null,
    contribution_abs: d.contribution_abs,
    contribution_pct: deltaAbs !== 0 ? (d.contribution_abs / deltaAbs) * 100 : 0,
  }));

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

// Read-time shaping. For Class B, without a per-user can_access resolution we
// fail closed: every entity is treated as hidden and collapsed into a single
// "Other (all N hidden)" aggregate carrying only the total contribution, with no
// per-entity amounts (spec 2.2 / 4.5 absent-asker rule). Class A is served as-is.
function shapeForRead(
  row: typeof basisExplanations.$inferSelect,
  dimClass: 'A' | 'B',
) {
  const rawDrivers = (row.drivers as BasisDriver[]) ?? [];
  let drivers: BasisDriver[];
  if (dimClass === 'A') {
    drivers = rawDrivers;
  } else {
    const total = rawDrivers.reduce((s, d) => s + (d.contribution_abs ?? 0), 0);
    drivers = [
      {
        dimension_value: '__other__',
        label: `Other (all ${rawDrivers.length} hidden)`,
        contribution_abs: total,
        contribution_pct: 100,
        is_other: true,
        hidden_count: rawDrivers.length,
      },
    ];
  }
  return {
    metric_id: row.metric_id,
    version_id: row.version_id,
    cache_key: row.cache_key,
    dimension: row.dimension,
    dimension_class: row.dimension_class,
    delta_abs: row.delta_abs == null ? null : Number(row.delta_abs),
    delta_pct: row.delta_pct == null ? null : Number(row.delta_pct),
    drivers,
    narrative: row.narrative,
    // Per-viewer, access-scoped correlation aid. Empty until the can_access +
    // related_apps read-time resolver is wired (ranked below drivers regardless).
    correlation: [] as Record<string, unknown>[],
    computed_at: row.computed_at,
  };
}
