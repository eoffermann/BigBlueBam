import { env } from '../env.js';
import type { BasisDefinition } from '@bigbluebam/shared';

// Thrown when the Bench internal query route is unreachable / not configured.
// The routes translate this into a typed 503 UPSTREAM_UNAVAILABLE so a Bench
// outage never hangs or 500s Basis (spec 8.4).
export class UpstreamUnavailableError extends Error {
  constructor(message = 'Bench query service unavailable') {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}

interface QueryRow {
  [k: string]: unknown;
}

// Call the Bench internal governed-query route (mode b: INTERNAL_SERVICE_SECRET
// + explicit org_id). Basis passes an org_id it has already authenticated.
async function runQuery(
  orgId: string,
  product: string,
  entity: string,
  config: Record<string, unknown>,
): Promise<QueryRow[]> {
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!secret) throw new UpstreamUnavailableError('INTERNAL_SERVICE_SECRET not configured');

  const url = `${env.BENCH_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/query`;
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.QUERY_TIMEOUT_MS + 2000);
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
        body: JSON.stringify({ product, entity, org_id: orgId, config }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw new UpstreamUnavailableError();
  }
  if (!res.ok) {
    // 5xx or the route not present -> treat as upstream unavailable so callers
    // degrade rather than surface a raw error.
    throw new UpstreamUnavailableError(`Bench internal query returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: { rows?: QueryRow[] } };
  return json.data?.rows ?? [];
}

function mapFilters(def: BasisDefinition): Record<string, unknown>[] | undefined {
  if (!def.filters?.length) return undefined;
  return def.filters.map((f) => ({ field: f.field, op: f.op, value: f.value }));
}

// Scalar value of a metric over a period.
export async function queryScalar(
  orgId: string,
  def: BasisDefinition,
  period: { from: string; to: string },
): Promise<number | null> {
  const config: Record<string, unknown> = {
    measures: [{ field: def.measure.field, agg: def.measure.agg, alias: 'value' }],
    filters: mapFilters(def),
    time_dimension: { field: def.time_column, granularity: 'day' },
    date_range: { start: period.from, end: period.to },
  };
  const rows = await runQuery(orgId, def.source_product, def.source_entity, config);
  if (!rows.length) return null;
  const v = rows[0]!.value;
  return v == null ? null : Number(v);
}

// Grouped-by-dimension values of a metric over a period (for decomposition).
export async function queryGrouped(
  orgId: string,
  def: BasisDefinition,
  dimension: string,
  period: { from: string; to: string },
): Promise<Map<string, number>> {
  const config: Record<string, unknown> = {
    measures: [{ field: def.measure.field, agg: def.measure.agg, alias: 'value' }],
    dimensions: [{ field: dimension, alias: 'dim' }],
    filters: mapFilters(def),
    time_dimension: { field: def.time_column, granularity: 'day' },
    date_range: { start: period.from, end: period.to },
  };
  const rows = await runQuery(orgId, def.source_product, def.source_entity, config);
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = r.dim == null ? '(null)' : String(r.dim);
    out.set(key, Number(r.value ?? 0));
  }
  return out;
}
