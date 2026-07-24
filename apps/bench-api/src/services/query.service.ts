import { readConnection } from '../db/index.js';
import { env } from '../env.js';
import { DEFAULT_ORG_COLUMN, getDataSource } from '../lib/data-source-registry.js';
import type { BenchDataSource } from '../lib/data-source-registry.js';
import { badRequest } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Field references
// ---------------------------------------------------------------------------
// A field is normally a plain column, but any measure/dimension/filter/time
// field may instead reach into a JSONB column by supplying `path` — the list of
// keys to walk (e.g. ['metrics','total_processing_ms']). This is what lets Bench
// chart Blip telemetry (all in blip_entries.payload) WITHOUT flattening every
// new tracked field into its own DB column: new payload keys are instantly
// queryable, no migration. The path is bound as a parameter (never interpolated)
// and the JSONB column must be allow-listed on the source (`jsonbColumns`), so
// this adds reach, not injection surface. `cast` coerces the extracted text to a
// typed value for aggregation/comparison (default numeric for measures, text for
// dimensions/filters, timestamptz for a time dimension).
export type FieldCast =
  | 'numeric' | 'integer' | 'bigint' | 'double' | 'boolean' | 'text' | 'timestamptz' | 'date';

export interface FieldRef {
  field: string;
  path?: string[];
  cast?: FieldCast;
}

// A dimension whose value is missing (NULL) or empty groups into one bucket. By
// default that bucket renders blank in a chart; setting `null_label` on a
// dimension folds those rows into an explicit, labeled category (e.g. older Blip
// payloads with no device.device_model become "Unknown device") so the slice is
// tracked instead of hidden.

export interface QueryMeasure extends FieldRef {
  // count/sum/avg/min/max plus continuous percentiles (p50/p90/p95/p99), which
  // are what latency telemetry actually needs — an average hides the tail.
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p90' | 'p95' | 'p99';
  alias?: string;
}

export interface QueryDimension extends FieldRef {
  alias?: string;
  /** Fold NULL/empty values into this labeled bucket instead of a blank group. */
  null_label?: string;
}

export interface QueryFilter extends FieldRef {
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null' | 'is_not_null' | 'between' | 'like';
  value?: unknown;
}

export interface TimeDimension extends FieldRef {
  granularity: 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';
}

export interface DateRange {
  preset?: string;
  start?: string;
  end?: string;
}

export interface QueryConfig {
  measures: QueryMeasure[];
  dimensions?: QueryDimension[];
  filters?: QueryFilter[];
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  time_dimension?: TimeDimension;
  date_range?: DateRange;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ALLOWED_IDENTS = /^[a-z_][a-z0-9_]*$/;

/** Strict ISO 8601 date/datetime pattern — rejects anything that isn't a plain date or timestamp. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;

function validateIdent(name: string): string {
  if (!ALLOWED_IDENTS.test(name)) {
    throw badRequest(`Invalid identifier: ${name}`);
  }
  return name;
}

function validateDateString(value: string): string {
  if (!ISO_DATE_RE.test(value)) {
    throw badRequest(`Invalid date value: ${value}`);
  }
  // Also verify it parses to a real date
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`Invalid date value: ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Parameterized query builder
// ---------------------------------------------------------------------------

/** Accumulates positional parameters ($1, $2, ...) alongside the SQL string. */
interface ParameterizedQuery {
  text: string;
  params: string[];
}

function addParam(pq: ParameterizedQuery, value: string): string {
  pq.params.push(value);
  return `$${pq.params.length}`;
}

// Allow-listed casts → the exact SQL type keyword. User input never reaches SQL
// as a type; it only selects one of these fixed keywords.
const CAST_SQL: Record<FieldCast, string> = {
  numeric: 'numeric',
  integer: 'integer',
  bigint: 'bigint',
  double: 'double precision',
  boolean: 'boolean',
  text: 'text',
  timestamptz: 'timestamptz',
  date: 'date',
};

const MAX_PATH_SEGMENTS = 16;

/** Build a safe Postgres text[] literal, e.g. ['a','b"c'] -> {"a","b\"c"}. */
function pgTextArrayLiteral(segments: string[]): string {
  const quoted = segments.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${quoted.join(',')}}`;
}

/** Derive a valid SQL identifier alias from a JSONB path's last segment. */
function aliasFromPath(path: string[]): string {
  const last = path[path.length - 1] ?? 'value';
  const cleaned = last.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
  return ALLOWED_IDENTS.test(cleaned) ? cleaned : 'value';
}

/**
 * Resolve a field reference to a SQL expression, appending any bound parameters.
 * Plain columns pass through validateIdent unchanged (existing behavior). JSONB
 * fields become `(col #>> $n::text[])` with an optional typed cast; the path is a
 * bound parameter and the column must be allow-listed on the source.
 */
function resolveFieldExpr(
  ref: FieldRef,
  source: BenchDataSource,
  pq: ParameterizedQuery,
  defaultCast?: FieldCast,
): string {
  if (!ref.path || ref.path.length === 0) {
    // Plain column; a cast may still be requested (rare, but harmless).
    const col = validateIdent(ref.field);
    if (ref.cast) return `${col}::${CAST_SQL[ref.cast] ?? invalidCast(ref.cast)}`;
    return col;
  }
  const col = validateIdent(ref.field);
  if (!source.jsonbColumns?.includes(col)) {
    throw badRequest(`JSONB path not allowed on column: ${col}`);
  }
  if (ref.path.length > MAX_PATH_SEGMENTS) {
    throw badRequest(`JSONB path too deep (max ${MAX_PATH_SEGMENTS} segments)`);
  }
  for (const seg of ref.path) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.length > 128) {
      throw badRequest(`Invalid JSONB path segment: ${String(seg)}`);
    }
  }
  const pathParam = addParam(pq, pgTextArrayLiteral(ref.path));
  const base = `(${col} #>> ${pathParam}::text[])`;
  const cast = ref.cast ?? defaultCast;
  if (!cast) return base;
  const sqlType = CAST_SQL[cast] ?? invalidCast(cast);
  return `${base}::${sqlType}`;
}

function invalidCast(cast: string): never {
  throw badRequest(`Invalid cast: ${cast}`);
}

const PERCENTILE_FRACTION: Record<string, number> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 };

/**
 * SQL for one measure's aggregate (without the trailing ` AS alias`). COUNT works
 * on the raw extracted value; every other aggregate needs a number, so a JSONB
 * measure defaults to a numeric cast. Percentiles use percentile_cont — the tail
 * that averages hide, which is the point of tracking latency.
 */
function measureSql(m: QueryMeasure, source: BenchDataSource, pq: ParameterizedQuery): string {
  if (m.agg === 'count') {
    // Count of non-null values; no cast needed (a JSONB miss extracts to NULL).
    return `COUNT(${resolveFieldExpr(m, source, pq)})`;
  }
  const numericDefault: FieldCast = 'numeric';
  const expr = resolveFieldExpr(m, source, pq, m.path ? m.cast ?? numericDefault : m.cast);
  const frac = PERCENTILE_FRACTION[m.agg];
  if (frac !== undefined) {
    return `percentile_cont(${frac}) WITHIN GROUP (ORDER BY ${expr})`;
  }
  return `${m.agg.toUpperCase()}(${expr})`;
}

function buildFilterClause(f: QueryFilter, pq: ParameterizedQuery, source: BenchDataSource): string {
  // Numeric comparisons cast the extracted JSONB text to a number; equality /
  // membership / pattern ops compare as text. Explicit f.cast always wins.
  // #>> already yields text, so equality/pattern ops need no cast; only numeric
  // comparisons default to a numeric cast (an explicit f.cast always wins).
  const numericOp = f.op === 'gt' || f.op === 'gte' || f.op === 'lt' || f.op === 'lte' || f.op === 'between';
  const field = resolveFieldExpr(f, source, pq, numericOp ? 'numeric' : undefined);
  switch (f.op) {
    case 'eq': return `${field} = ${addParam(pq, String(f.value))}`;
    case 'neq': return `${field} != ${addParam(pq, String(f.value))}`;
    case 'gt': return `${field} > ${addParam(pq, String(f.value))}`;
    case 'gte': return `${field} >= ${addParam(pq, String(f.value))}`;
    case 'lt': return `${field} < ${addParam(pq, String(f.value))}`;
    case 'lte': return `${field} <= ${addParam(pq, String(f.value))}`;
    case 'is_null': return `${field} IS NULL`;
    case 'is_not_null': return `${field} IS NOT NULL`;
    case 'in': {
      if (!Array.isArray(f.value)) throw badRequest('IN filter requires an array value');
      const placeholders = (f.value as unknown[]).map((v) => addParam(pq, String(v)));
      return `${field} IN (${placeholders.join(', ')})`;
    }
    case 'between': {
      if (!Array.isArray(f.value) || f.value.length !== 2) throw badRequest('BETWEEN requires [start, end]');
      return `${field} BETWEEN ${addParam(pq, String(f.value[0]))} AND ${addParam(pq, String(f.value[1]))}`;
    }
    case 'like': return `${field} ILIKE ${addParam(pq, `%${String(f.value).replace(/[%_\\]/g, '\\$&')}%`)}`;
    default: throw badRequest(`Unknown filter operator: ${f.op}`);
  }
}

function resolveDateRange(dr: DateRange): { start: string; end: string } | null {
  if (dr.start && dr.end) {
    return { start: validateDateString(dr.start), end: validateDateString(dr.end) };
  }
  if (!dr.preset) return null;

  const now = new Date();
  let start: Date;
  switch (dr.preset) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'last_1_days':
      start = new Date(now.getTime() - 1 * 86400000);
      break;
    case 'last_2_days':
      start = new Date(now.getTime() - 2 * 86400000);
      break;
    case 'last_7_days':
      start = new Date(now.getTime() - 7 * 86400000);
      break;
    case 'last_30_days':
      start = new Date(now.getTime() - 30 * 86400000);
      break;
    case 'last_90_days':
      start = new Date(now.getTime() - 90 * 86400000);
      break;
    case 'this_month':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      break;
    }
    case 'this_year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      return null;
  }
  return { start: start.toISOString(), end: now.toISOString() };
}

/**
 * Pick the column a `date_range` should be applied against when the caller did
 * NOT supply an explicit `time_dimension`. We use the source's first declared
 * temporal dimension (e.g. Bureau's `day`, Bond's `created_at`). Returns null
 * when the source has no temporal dimension, in which case the date range is
 * simply not applied (rather than guessing at a column that may not exist).
 */
function resolveTemporalColumn(source: BenchDataSource): string | null {
  const temporal = source.dimensions.find((d) => d.type === 'temporal');
  return temporal ? temporal.field : null;
}

/**
 * Build a parameterized analytical query.
 *
 * @param orgId - The authenticated user's organization ID, always injected as
 *   a WHERE filter to enforce tenant isolation.
 */
export function buildQuery(
  product: string,
  entity: string,
  config: QueryConfig,
  orgId: string,
): ParameterizedQuery {
  const source = getDataSource(product, entity);
  if (!source) throw badRequest(`Unknown data source: ${product}.${entity}`);

  const table = validateIdent(source.baseTable);
  const pq: ParameterizedQuery = { text: '', params: [] };

  // Build SELECT columns
  const selectParts: string[] = [];
  // GROUP BY references the SELECT aliases (Postgres allows grouping by output
  // name), so a JSONB dimension expression is emitted once and never duplicated.
  const groupByAliases: string[] = [];

  // Time dimension — plain column or a JSONB path cast to a timestamp.
  if (config.time_dimension) {
    const tf = resolveFieldExpr(
      config.time_dimension,
      source,
      pq,
      config.time_dimension.path ? 'timestamptz' : undefined,
    );
    const gran = validateIdent(config.time_dimension.granularity);
    selectParts.push(`date_trunc('${gran}', ${tf}) AS time_bucket`);
  }

  // Dimensions
  if (config.dimensions) {
    for (const dim of config.dimensions) {
      // #>> already returns text; only an explicit dim.cast (e.g. integer RAM)
      // adds a cast, so a plain categorical dimension stays clean.
      const baseExpr = resolveFieldExpr(dim, source, pq);
      const alias = dim.alias
        ? validateIdent(dim.alias)
        : dim.path
          ? aliasFromPath(dim.path)
          : validateIdent(dim.field);
      // Fold NULL/empty into a labeled bucket when requested (e.g. "Unknown device").
      const expr =
        dim.null_label !== undefined
          ? `COALESCE(NULLIF(${baseExpr}::text, ''), ${addParam(pq, dim.null_label)})`
          : baseExpr;
      selectParts.push(expr === alias ? expr : `${expr} AS ${alias}`);
      groupByAliases.push(alias);
    }
  }

  // Measures
  for (const m of config.measures) {
    const alias = validateIdent(m.alias ?? `${m.agg}_${m.path ? aliasFromPath(m.path) : m.field}`);
    selectParts.push(`${measureSql(m, source, pq)} AS ${alias}`);
  }

  if (selectParts.length === 0) throw badRequest('Query must have at least one measure');

  // Build WHERE — always starts with tenant isolation on the source's org
  // column. Most sources use `organization_id`; bureau_* tables use `org_id`.
  // The literal comes from the trusted registry (not user input) but we still
  // run it through validateIdent as defense-in-depth.
  const orgColumn = validateIdent(source.orgColumn ?? DEFAULT_ORG_COLUMN);
  const whereParts: string[] = [`${orgColumn} = ${addParam(pq, orgId)}`];

  if (config.filters) {
    for (const f of config.filters) {
      whereParts.push(buildFilterClause(f, pq, source));
    }
  }

  // Apply date range. When the caller supplies an explicit time_dimension we
  // scope against that column (existing behavior). Otherwise we fall back to
  // the source's own temporal dimension (e.g. bureau's `day`) so seeded widgets
  // that set `date_range` but no `time_dimension` are still scoped instead of
  // silently scanning the whole table.
  if (config.date_range) {
    const range = resolveDateRange(config.date_range);
    if (range) {
      // Scope against the explicit time_dimension (which may be a JSONB path) or,
      // failing that, the source's declared temporal column.
      let tf: string | null = null;
      if (config.time_dimension) {
        tf = resolveFieldExpr(
          config.time_dimension,
          source,
          pq,
          config.time_dimension.path ? 'timestamptz' : undefined,
        );
      } else {
        const col = resolveTemporalColumn(source);
        tf = col ? validateIdent(col) : null;
      }
      if (tf) {
        whereParts.push(`${tf} >= ${addParam(pq, range.start)}`);
        whereParts.push(`${tf} <= ${addParam(pq, range.end)}`);
      }
    }
  }

  // Build GROUP BY — references the SELECT-list aliases emitted above so JSONB
  // dimension expressions are never duplicated (and never mismatched).
  const groupByParts: string[] = [];
  if (config.time_dimension) groupByParts.push('time_bucket');
  groupByParts.push(...groupByAliases);

  // Build ORDER BY
  let orderBy = '';
  if (config.sort && config.sort.length > 0) {
    const sortParts = config.sort.map((s) => {
      const f = validateIdent(s.field);
      return `${f} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`;
    });
    orderBy = `ORDER BY ${sortParts.join(', ')}`;
  } else if (config.time_dimension) {
    orderBy = 'ORDER BY time_bucket ASC';
  }

  // Build LIMIT
  const limit = Math.min(config.limit ?? 1000, 10000);

  // Assemble query
  let q = `SELECT ${selectParts.join(', ')} FROM ${table}`;
  q += ` WHERE ${whereParts.join(' AND ')}`;
  if (groupByParts.length > 0) q += ` GROUP BY ${groupByParts.join(', ')}`;
  if (orderBy) q += ` ${orderBy}`;
  q += ` LIMIT ${limit}`;

  pq.text = q;
  return pq;
}

// ---------------------------------------------------------------------------
// Date-range-aware result caching (optional, injected from server.ts)
// ---------------------------------------------------------------------------

import type { CacheService } from './cache.service.js';

let _cacheService: CacheService | null = null;

export function setQueryCacheService(cs: CacheService): void {
  _cacheService = cs;
}

export async function executeQuery(
  product: string,
  entity: string,
  config: QueryConfig,
  orgId: string,
): Promise<{ rows: Record<string, unknown>[]; sql?: string; duration_ms: number; cached?: boolean }> {
  // Try date-range-aware cache before hitting the DB
  if (_cacheService && config.date_range) {
    const configHash = _cacheService.hashQueryConfig(config as unknown as Record<string, unknown>);
    const cacheKey = _cacheService.buildAdHocCacheKey(configHash, config.date_range, orgId);
    if (cacheKey) {
      const cached = await _cacheService.getAdHoc(cacheKey);
      if (cached) {
        return cached as { rows: Record<string, unknown>[]; duration_ms: number; cached: boolean };
      }
    }
  }

  const pq = buildQuery(product, entity, config, orgId);
  const start = Date.now();

  try {
    // Run inside a transaction so SET LOCAL is scoped and automatically reset
    const result = await readConnection.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${Number(env.QUERY_TIMEOUT_MS)}ms'`);
      return tx.unsafe(pq.text, pq.params);
    });
    const duration_ms = Date.now() - start;
    const output = {
      rows: Array.isArray(result) ? (result as Record<string, unknown>[]) : [],
      ...(env.NODE_ENV !== 'production' ? { sql: pq.text } : {}),
      duration_ms,
    };

    // Cache the result if the date range is historical (not including today)
    if (_cacheService && config.date_range) {
      const configHash = _cacheService.hashQueryConfig(config as unknown as Record<string, unknown>);
      const cacheKey = _cacheService.buildAdHocCacheKey(configHash, config.date_range, orgId);
      if (cacheKey) {
        // Store without the sql field for security
        const toCache = { rows: output.rows, duration_ms: output.duration_ms, cached: true };
        _cacheService.setAdHoc(cacheKey, toCache).catch(() => {
          // Best-effort cache write
        });
      }
    }

    return output;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('statement timeout')) {
      throw badRequest('Query exceeded timeout. Try narrowing your filters or reducing the date range.');
    }
    throw err;
  }
}
