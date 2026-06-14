import { readConnection } from '../db/index.js';
import { env } from '../env.js';
import { DEFAULT_ORG_COLUMN, getDataSource } from '../lib/data-source-registry.js';
import type { BenchDataSource } from '../lib/data-source-registry.js';
import { badRequest } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryMeasure {
  field: string;
  agg: 'count' | 'sum' | 'avg' | 'min' | 'max';
  alias?: string;
}

export interface QueryDimension {
  field: string;
  alias?: string;
}

export interface QueryFilter {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is_null' | 'is_not_null' | 'between' | 'like';
  value?: unknown;
}

export interface TimeDimension {
  field: string;
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

function buildFilterClause(f: QueryFilter, pq: ParameterizedQuery): string {
  const field = validateIdent(f.field);
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

  // Time dimension
  if (config.time_dimension) {
    const tf = validateIdent(config.time_dimension.field);
    const gran = validateIdent(config.time_dimension.granularity);
    selectParts.push(`date_trunc('${gran}', ${tf}) AS time_bucket`);
  }

  // Dimensions
  if (config.dimensions) {
    for (const dim of config.dimensions) {
      const f = validateIdent(dim.field);
      const alias = dim.alias ? validateIdent(dim.alias) : f;
      selectParts.push(alias === f ? f : `${f} AS ${alias}`);
    }
  }

  // Measures
  for (const m of config.measures) {
    const f = validateIdent(m.field);
    const alias = m.alias ? validateIdent(m.alias) : `${m.agg}_${f}`;
    if (m.agg === 'count') {
      selectParts.push(`COUNT(${f}) AS ${validateIdent(alias)}`);
    } else {
      selectParts.push(`${m.agg.toUpperCase()}(${f}) AS ${validateIdent(alias)}`);
    }
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
      whereParts.push(buildFilterClause(f, pq));
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
      const temporalField = config.time_dimension
        ? config.time_dimension.field
        : resolveTemporalColumn(source);
      if (temporalField) {
        const tf = validateIdent(temporalField);
        whereParts.push(`${tf} >= ${addParam(pq, range.start)}`);
        whereParts.push(`${tf} <= ${addParam(pq, range.end)}`);
      }
    }
  }

  // Build GROUP BY
  const groupByParts: string[] = [];
  if (config.time_dimension) groupByParts.push('time_bucket');
  if (config.dimensions) {
    for (const dim of config.dimensions) {
      groupByParts.push(validateIdent(dim.field));
    }
  }

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
  } catch (err: any) {
    if (err.message?.includes('statement timeout')) {
      throw badRequest('Query exceeded timeout. Try narrowing your filters or reducing the date range.');
    }
    throw err;
  }
}
