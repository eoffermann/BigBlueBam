/**
 * Blip entry query / tail / purge engine (Blip §7, §12.4, §11.2). Builds
 * org-scoped SQL over the partitioned blip_entries store using the compiled
 * filter predicate. `seq` is serialized as text to avoid JS bigint JSON issues.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { compilePredicateSql, type Predicate } from '../lib/predicate.js';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return ((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
}

const SELECT_COLS = sql`received_at, id, seq::text AS seq, org_id, tracked_app_id, report_type,
  ingest_key_id, client_ts, level, session_id, app_version, platform, elapsed_ms,
  capture_count, payload, payload_bytes`;

const RESERVED_SORT = new Set([
  'received_at',
  'seq',
  'level',
  'session_id',
  'app_version',
  'platform',
  'elapsed_ms',
  'capture_count',
  'client_ts',
]);

function orderSql(sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>): SQL {
  if (!sort || sort.length === 0) return sql`seq DESC`;
  const parts: SQL[] = [];
  for (const s of sort) {
    const dir = s.dir === 'asc' ? sql`ASC` : sql`DESC`;
    if (RESERVED_SORT.has(s.field)) {
      parts.push(sql`${sql.raw(s.field)} ${dir}`);
    } else if (s.field.startsWith('payload:')) {
      const path = `{${s.field
        .slice('payload:'.length)
        .split('.')
        .map((x) => x.replace(/[^A-Za-z0-9_$-]/g, ''))
        .join(',')}}`;
      parts.push(sql`(payload #>> ${path}) ${dir}`);
    }
  }
  if (parts.length === 0) return sql`seq DESC`;
  let acc = parts[0]!;
  for (let i = 1; i < parts.length; i++) acc = sql`${acc}, ${parts[i]!}`;
  return acc;
}

export type QueryArgs = {
  orgId: string;
  trackedAppId: string;
  reportType: string;
  filter?: Predicate;
  sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>;
  pageSize?: number;
  offset?: number;
};

export async function queryEntries(args: QueryArgs) {
  const limit = Math.min(Math.max(args.pageSize ?? 100, 1), 1000);
  const offset = Math.max(args.offset ?? 0, 0);
  const where = sql`org_id = ${args.orgId} AND tracked_app_id = ${args.trackedAppId}
    AND report_type = ${args.reportType} AND ${compilePredicateSql(args.filter)}`;
  const rows = rowsOf(
    await db.execute(
      sql`SELECT ${SELECT_COLS} FROM blip_entries WHERE ${where} ORDER BY ${orderSql(args.sort)} LIMIT ${limit} OFFSET ${offset}`,
    ),
  );
  const countRows = rowsOf(await db.execute(sql`SELECT count(*)::int AS c FROM blip_entries WHERE ${where}`));
  const total = Number(countRows[0]?.c ?? 0);
  return { rows, total, page_size: limit, offset };
}

/** Incremental pull: entries with seq > cursor (oldest-first), plus new max seq. */
export async function tailEntries(args: {
  orgId: string;
  trackedAppId: string;
  reportType: string;
  cursorSeq?: string | number;
  filter?: Predicate;
  limit?: number;
}) {
  const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
  const cursor = String(args.cursorSeq ?? 0);
  const where = sql`org_id = ${args.orgId} AND tracked_app_id = ${args.trackedAppId}
    AND report_type = ${args.reportType} AND seq > ${cursor} AND ${compilePredicateSql(args.filter)}`;
  const rows = rowsOf(
    await db.execute(sql`SELECT ${SELECT_COLS} FROM blip_entries WHERE ${where} ORDER BY seq ASC LIMIT ${limit}`),
  );
  const maxSeq = rows.length > 0 ? String(rows[rows.length - 1]!.seq) : cursor;
  return { entries: rows, max_seq: maxSeq };
}

/** Most-recent matching page (seq desc) for WS backfill on connect. */
export async function backfillEntries(args: {
  orgId: string;
  trackedAppId: string;
  reportType: string;
  filter?: Predicate;
  limit?: number;
  sinceSeq?: string;
}) {
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  if (args.sinceSeq) {
    const r = await tailEntries({ ...args, cursorSeq: args.sinceSeq, limit });
    return r.entries;
  }
  const where = sql`org_id = ${args.orgId} AND tracked_app_id = ${args.trackedAppId}
    AND report_type = ${args.reportType} AND ${compilePredicateSql(args.filter)}`;
  const rows = rowsOf(
    await db.execute(sql`SELECT ${SELECT_COLS} FROM blip_entries WHERE ${where} ORDER BY seq DESC LIMIT ${limit}`),
  );
  return rows.reverse(); // backfill is delivered oldest-first
}

/** Purge a collection (Blip §11.2). Returns deleted count and emits entries.purged. */
export async function purgeEntries(args: {
  orgId: string;
  trackedAppId: string;
  reportType: string;
  filter?: Predicate;
}): Promise<{ deleted: number }> {
  const where = sql`org_id = ${args.orgId} AND tracked_app_id = ${args.trackedAppId}
    AND report_type = ${args.reportType} AND ${compilePredicateSql(args.filter)}`;
  const res = rowsOf(await db.execute(sql`DELETE FROM blip_entries WHERE ${where} RETURNING id`));
  const deleted = res.length;
  void publishBoltEvent('entries.purged', 'blip', {
    tracked_app_id: args.trackedAppId,
    report_type: args.reportType,
    deleted,
  }, args.orgId);
  return { deleted };
}
