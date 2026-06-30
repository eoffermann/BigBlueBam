/**
 * Blip filter-predicate engine (Blip §7.1).
 *
 * A predicate is a recursive AND/OR condition tree. Each leaf is
 * `{ field, operator, value }` where `field` is either a reserved column name
 * or `payload:<dot.path>` resolving to the JSONB blob. This module compiles a
 * predicate to (a) a Drizzle SQL fragment for the durable query path, and
 * (b) an in-memory boolean evaluator for the live-tail gateway and match-watch
 * edge evaluation.
 *
 * This shape is net-new to Blip (the suite has no shared recursive condition
 * tree); it standardizes on `operator` (not `op`) per the design doc.
 */
import { sql, type SQL } from 'drizzle-orm';

export type LeafOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'is_set'
  | 'is_not_set';

export type Leaf = {
  field: string;
  operator: LeafOperator;
  value?: unknown;
};

export type Predicate =
  | { op: 'and' | 'or'; conditions: Predicate[] }
  | Leaf;

// Reserved promoted columns (Blip §6). Numeric columns get numeric comparisons.
const RESERVED_NUMERIC = new Set(['elapsed_ms', 'capture_count', 'seq']);
const RESERVED = new Set([
  'report_type',
  'level',
  'session_id',
  'app_version',
  'platform',
  'elapsed_ms',
  'capture_count',
  'received_at',
  'client_ts',
  'seq',
]);

function isLeaf(p: Predicate): p is Leaf {
  return typeof (p as Leaf).field === 'string';
}

// ---------------------------------------------------------------------------
// SQL compilation
// ---------------------------------------------------------------------------

function jsonbPathArray(dotPath: string): string {
  // 'a.b.c' -> '{a,b,c}' (Postgres text[] literal). Segments are alphanumeric
  // field paths from the catalog; reject anything with braces/quotes.
  const segs = dotPath
    .split('.')
    .map((s) => s.replace(/[^A-Za-z0-9_$-]/g, ''))
    .filter(Boolean);
  return `{${segs.join(',')}}`;
}

function fieldSql(field: string): { ref: SQL; numericRef: SQL; isReserved: boolean } {
  if (field.startsWith('payload:')) {
    const path = jsonbPathArray(field.slice('payload:'.length));
    const ref = sql`(payload #>> ${path})`;
    return { ref, numericRef: sql`((payload #>> ${path}))::numeric`, isReserved: false };
  }
  if (!RESERVED.has(field)) {
    // Unknown bare field: treat as a top-level payload key, coerced to text.
    const path = jsonbPathArray(field);
    const ref = sql`(payload #>> ${path})`;
    return { ref, numericRef: sql`((payload #>> ${path}))::numeric`, isReserved: false };
  }
  const col = sql.raw(field); // reserved column names are from a fixed allowlist
  return { ref: col, numericRef: col, isReserved: true };
}

function leafToSql(leaf: Leaf): SQL {
  const { ref, numericRef, isReserved } = fieldSql(leaf.field);
  const numeric = isReserved
    ? RESERVED_NUMERIC.has(leaf.field)
    : typeof leaf.value === 'number';
  const cmpRef = numeric ? numericRef : ref;
  const v = leaf.value;
  switch (leaf.operator) {
    case 'eq':
      return numeric ? sql`${cmpRef} = ${v}` : sql`${ref} = ${String(v)}`;
    case 'neq':
      return numeric ? sql`${cmpRef} <> ${v}` : sql`${ref} <> ${String(v)}`;
    case 'gt':
      return sql`${cmpRef} > ${v}`;
    case 'gte':
      return sql`${cmpRef} >= ${v}`;
    case 'lt':
      return sql`${cmpRef} < ${v}`;
    case 'lte':
      return sql`${cmpRef} <= ${v}`;
    case 'contains':
      return sql`${ref} ILIKE ${'%' + String(v) + '%'}`;
    case 'not_contains':
      return sql`(${ref} IS NULL OR ${ref} NOT ILIKE ${'%' + String(v) + '%'})`;
    case 'in': {
      const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x));
      if (arr.length === 0) return sql`false`;
      return sql`${ref} = ANY(${arr})`;
    }
    case 'not_in': {
      const arr = (Array.isArray(v) ? v : [v]).map((x) => String(x));
      if (arr.length === 0) return sql`true`;
      return sql`(${ref} IS NULL OR ${ref} <> ALL(${arr}))`;
    }
    case 'is_set':
      return sql`${ref} IS NOT NULL`;
    case 'is_not_set':
      return sql`${ref} IS NULL`;
    default:
      return sql`true`;
  }
}

/** Compile a predicate to a SQL boolean fragment. Empty/undefined -> TRUE. */
export function compilePredicateSql(predicate: Predicate | undefined | null): SQL {
  if (!predicate) return sql`true`;
  if (isLeaf(predicate)) return leafToSql(predicate);
  const parts = predicate.conditions.map((c) => compilePredicateSql(c));
  if (parts.length === 0) return sql`true`;
  const joiner = predicate.op === 'or' ? sql` OR ` : sql` AND `;
  let acc = parts[0]!;
  for (let i = 1; i < parts.length; i++) acc = sql`${acc}${joiner}${parts[i]!}`;
  return sql`(${acc})`;
}

// ---------------------------------------------------------------------------
// In-memory evaluation (tail gateway + match-watch edge)
// ---------------------------------------------------------------------------

type EvalRecord = {
  report_type?: string | null;
  level?: string | null;
  session_id?: string | null;
  app_version?: string | null;
  platform?: string | null;
  elapsed_ms?: number | null;
  capture_count?: number | null;
  received_at?: string | null;
  client_ts?: string | null;
  seq?: string | number | null;
  payload: Record<string, unknown>;
};

function readField(rec: EvalRecord, field: string): unknown {
  if (field.startsWith('payload:')) {
    return readPath(rec.payload, field.slice('payload:'.length));
  }
  if (RESERVED.has(field)) return (rec as Record<string, unknown>)[field] ?? null;
  return readPath(rec.payload, field);
}

function readPath(obj: Record<string, unknown> | undefined, dotPath: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const seg of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function evalLeaf(rec: EvalRecord, leaf: Leaf): boolean {
  const raw = readField(rec, leaf.field);
  const v = leaf.value;
  switch (leaf.operator) {
    case 'is_set':
      return raw !== undefined && raw !== null;
    case 'is_not_set':
      return raw === undefined || raw === null;
    case 'eq':
      return raw != null && String(raw) === String(v);
    case 'neq':
      return raw == null || String(raw) !== String(v);
    case 'contains':
      return raw != null && String(raw).toLowerCase().includes(String(v).toLowerCase());
    case 'not_contains':
      return raw == null || !String(raw).toLowerCase().includes(String(v).toLowerCase());
    case 'gt':
      return raw != null && Number(raw) > Number(v);
    case 'gte':
      return raw != null && Number(raw) >= Number(v);
    case 'lt':
      return raw != null && Number(raw) < Number(v);
    case 'lte':
      return raw != null && Number(raw) <= Number(v);
    case 'in':
      return raw != null && (Array.isArray(v) ? v : [v]).map(String).includes(String(raw));
    case 'not_in':
      return raw == null || !(Array.isArray(v) ? v : [v]).map(String).includes(String(raw));
    default:
      return true;
  }
}

/** Evaluate a predicate against an in-memory record. Empty/undefined -> true. */
export function evalPredicate(predicate: Predicate | undefined | null, rec: EvalRecord): boolean {
  if (!predicate) return true;
  if (isLeaf(predicate)) return evalLeaf(rec, predicate);
  const results = predicate.conditions.map((c) => evalPredicate(c, rec));
  return predicate.op === 'or' ? results.some(Boolean) : results.every(Boolean);
}
