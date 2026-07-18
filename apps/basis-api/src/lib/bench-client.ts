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

// A 4xx from Bench means the metric DEFINITION is invalid (bad data source,
// unknown field, etc.) - a client error to surface distinctly, NOT an outage.
export class BadDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadDefinitionError';
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
    let benchMsg = `Bench internal query returned ${res.status}`;
    try {
      const body = (await res.clone().json()) as { error?: { message?: string } };
      if (body.error?.message) benchMsg = body.error.message;
    } catch {
      /* non-JSON body */
    }
    // 4xx (except 401/403 auth) = the definition is invalid; surface distinctly.
    // 401/403/5xx/network = the route is down/misconfigured -> degrade.
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
      throw new BadDefinitionError(benchMsg);
    }
    throw new UpstreamUnavailableError(benchMsg);
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

// Write-time drift guard (spec 4.2 / reuse ledger): round-trip the definition
// through Bench's governed query builder to confirm it still resolves against its
// source. Returns a definitive verdict only:
//   'ok'            - Bench accepted the query (source/fields/agg all resolve)
//   'resolve_failed'- Bench rejected the definition (bad source, unknown field)
//   'unknown'       - Bench was unreachable/misconfigured; do NOT flip status on
//                     a transient outage (a blip must not mark a metric broken).
// A tiny recent window is enough - Bench validates the source, fields, and agg
// regardless of range, so this is cheap.
export async function previewDefinition(
  orgId: string,
  def: BasisDefinition,
): Promise<'ok' | 'resolve_failed' | 'unknown'> {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400_000);
  try {
    await queryScalar(orgId, def, { from: from.toISOString(), to: to.toISOString() });
    return 'ok';
  } catch (err) {
    if (err instanceof BadDefinitionError) return 'resolve_failed';
    // UpstreamUnavailableError or anything else = transient / cannot verify.
    return 'unknown';
  }
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
