// #358: the repo-level guard against JS Date values interpolated into raw sql`...` templates
// (see ./no-raw-sql-date.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSqlDates, findSqlDatesInSource } from './no-raw-sql-date.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no source under apps/*/src or packages/*/src interpolates a Date into a sql template', () => {
  assert.deepEqual(findSqlDates(ROOT), []);
});

test('the scan finds the #178 shape: a multi-line template with a conditional Date local', () => {
  const src = [
    "import { sql } from 'drizzle-orm';",
    'export async function f(allow: boolean, id: string) {',
    '  const now = allow ? new Date() : null;',
    '  await db.execute(sql`',
    '    UPDATE t',
    '    SET at = ${now}',
    '    WHERE id = ${id}',
    '  `);',
    '}',
  ].join('\n');
  const hits = findSqlDatesInSource(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 6);
  assert.equal(hits[0].text, 'now');
});

test('the scan finds inline new Date, Date-typed params and locals, and ?? fallbacks', () => {
  const src = [
    'function g(since: Date | null, until?: Date) {',
    '  let cutoff: Date;',
    '  cutoff = since ?? new Date();',
    '  const a = sql`x < ${new Date(Date.now() - 1000)}`;',
    '  const b = sql<number>`x > ${since}`;',
    '  const c = sql`x > ${until!}`;',
    '  const d = sql`x > ${cutoff}`;',
    '  const e = sql`x > ${since ?? new Date()}`;',
    '}',
  ].join('\n');
  assert.deepEqual(
    findSqlDatesInSource(src).map((h) => h.line),
    [4, 5, 6, 7, 8],
  );
});

test('the scan finds Date members read off a same-file interface, alias or inline type', () => {
  const src = [
    'interface Opts { orgId: string; since: Date; until?: Date | null }',
    'type Q = { before?: Date; q?: string };',
    'function k(opts: Opts, q: Q, r: { at: Date; n: number }) {',
    '  const a = sql`x >= ${opts.since} AND x < ${opts.until} AND o = ${opts.orgId}`;',
    '  const b = sql`x < ${q.before} AND t = ${q.q}`;',
    '  const c = sql`x = ${r.at} AND n = ${r.n}`;',
    '  const d = sql`x >= ${opts.since.toISOString()}::timestamptz`;',
    '}',
  ].join('\n');
  assert.deepEqual(
    findSqlDatesInSource(src).map((h) => h.text),
    ['opts.since', 'opts.until', 'q.before', 'r.at'],
  );
});

test('ISO strings, epoch numbers, other templates and shadowed names are not flagged', () => {
  const src = [
    'const at = new Date();',
    'function h(at: string) {',
    '  const iso = new Date().toISOString();',
    '  const ms = Date.now();',
    '  const a = sql`x < ${iso}::timestamptz`;',
    '  const b = sql`x < to_timestamp(${ms / 1000})`;',
    '  const c = sql`x < ${at}`;',
    '  const d = `plain ${new Date()}`;',
    '  const e = other`x ${new Date()}`;',
    '}',
  ].join('\n');
  assert.deepEqual(findSqlDatesInSource(src), []);
});
