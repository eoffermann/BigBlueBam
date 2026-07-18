// Pure, dependency-free decomposition + leak-safety helpers for the "why did it
// change" explainer. Kept in its own module (no db/env/bench imports) so the
// spec section 9 safety invariants - additive decomposition, Class-A/B
// classification, and Class-B read-time suppression - are unit-testable without a
// DB or Bench round trip. explain.service.ts re-exports and consumes these.
import type { BasisDriver } from '@bigbluebam/shared';

// Class-A: a CURATED allowlist of bounded org-global ENUM columns whose values
// are not per-user-restricted (spec 2.2). Deliberately narrow: generic names like
// `type`/`category`/`kind` are NOT included, because a governed source could
// expose a sensitive or high-cardinality column under such a name and it would
// then serve full per-value labels + amounts (security review #55). Anything not
// on this list is Class-B (entity-derived) and fails closed until the per-user
// can_access resolver is wired. Extend this set only with columns confirmed to be
// bounded, org-global enums.
export const CLASS_A_DIMENSIONS = new Set([
  'status',
  'stage',
  'state',
  'lifecycle_stage',
  'level',
  'priority',
]);

export function classifyDimension(dim: string): 'A' | 'B' {
  return CLASS_A_DIMENSIONS.has(dim) ? 'A' : 'B';
}

// Pure deterministic decomposition: contribution(g) = value_B(g) - value_A(g),
// delta = totalB - totalA. The additive invariant sum(contribution_abs) ===
// delta_abs holds by construction. Rows are sorted by descending magnitude.
export function computeDrivers(
  aMap: Map<string, number>,
  bMap: Map<string, number>,
  dimClass: 'A' | 'B',
): { drivers: BasisDriver[]; deltaAbs: number; deltaPct: number | null } {
  const keys = new Set([...aMap.keys(), ...bMap.keys()]);
  const raw: { dimension_value: string; contribution_abs: number }[] = [];
  let totalA = 0;
  let totalB = 0;
  for (const g of keys) {
    const av = aMap.get(g) ?? 0;
    const bv = bMap.get(g) ?? 0;
    totalA += av;
    totalB += bv;
    raw.push({ dimension_value: g, contribution_abs: bv - av });
  }
  const deltaAbs = totalB - totalA;
  const deltaPct = totalA !== 0 ? (deltaAbs / totalA) * 100 : null;
  raw.sort((x, y) => Math.abs(y.contribution_abs) - Math.abs(x.contribution_abs));
  const drivers: BasisDriver[] = raw.map((d) => ({
    dimension_value: d.dimension_value,
    label: dimClass === 'A' ? d.dimension_value : null,
    contribution_abs: d.contribution_abs,
    contribution_pct: deltaAbs !== 0 ? (d.contribution_abs / deltaAbs) * 100 : 0,
  }));
  return { drivers, deltaAbs, deltaPct };
}

// The persisted-explanation fields shapeForRead consumes (structural subset of
// the drizzle basis_explanations row; numeric columns arrive as strings).
export interface StoredExplanationRow {
  metric_id: string;
  version_id: string;
  cache_key: string;
  dimension: string | null;
  dimension_class: string | null;
  delta_abs: string | null;
  delta_pct: string | null;
  drivers: unknown;
  narrative: string | null;
  computed_at: Date | string;
}

// Class-B read-time shaping with k-anonymous secondary suppression (spec 2.2).
// `visibleValues` is the set of dimension values the asker is allowed to see (from
// a per-viewer can_access resolution); empty = absent-asker / nothing resolved =
// fail closed (everything hidden). Served (visible) rows carry their concrete
// label + amount; the rest collapse into one "Other" aggregate. CRITICAL k>=2
// rule: if exactly ONE row would be hidden while others are served, the asker
// could recover that single entity's amount by subtracting the served rows from
// the total (complementary disclosure), so we demote the smallest served row into
// the hidden set until at least two rows are hidden (or, if only one entity exists
// in total and none are served, the lone "all hidden" bucket equals the already
// public delta and is safe).
export function shapeClassBDrivers(
  rawDrivers: BasisDriver[],
  visibleValues: Iterable<string> = [],
): BasisDriver[] {
  const visibleSet = new Set(visibleValues);
  let served = rawDrivers.filter((d) => visibleSet.has(d.dimension_value));
  let hidden = rawDrivers.filter((d) => !visibleSet.has(d.dimension_value));

  // k>=2 secondary suppression: never leave a single hidden row alongside served
  // rows. Demote smallest-magnitude served rows until >=2 are hidden.
  if (served.length > 0) {
    served = [...served].sort(
      (a, b) => Math.abs(b.contribution_abs) - Math.abs(a.contribution_abs),
    );
    while (hidden.length === 1 && served.length > 0) {
      hidden = [...hidden, served.pop()!];
    }
  }

  const out: BasisDriver[] = served.map((d) => ({
    ...d,
    label: d.label ?? d.dimension_value,
  }));
  if (hidden.length > 0) {
    const total = hidden.reduce((s, d) => s + (d.contribution_abs ?? 0), 0);
    const pct = hidden.reduce((s, d) => s + (d.contribution_pct ?? 0), 0);
    out.push({
      dimension_value: '__other__',
      label:
        served.length === 0
          ? `Other (all ${hidden.length} hidden)`
          : `Other (${hidden.length} hidden)`,
      contribution_abs: total,
      contribution_pct: pct,
      is_other: true,
      hidden_count: hidden.length,
    });
  }
  return out;
}

// Read-time shaping. Class A is served as-is. Class B is shaped by
// shapeClassBDrivers with the asker's visible set (default empty = fail closed).
// Per-viewer correlation is added by the caller at read time (empty here).
export function shapeForRead(
  row: StoredExplanationRow,
  dimClass: 'A' | 'B',
  visibleValues: Iterable<string> = [],
) {
  const rawDrivers = (row.drivers as BasisDriver[]) ?? [];
  const drivers: BasisDriver[] =
    dimClass === 'A' ? rawDrivers : shapeClassBDrivers(rawDrivers, visibleValues);
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
    correlation: [] as Record<string, unknown>[],
    computed_at: row.computed_at,
  };
}
