// Parity guard for the two copies of the top-level SQL scanner (issue #149).
//
// apps/api/src/lib/migration-sql.ts decides what the migrate runner EXECUTES;
// scripts/lib/sql-top-level.mjs decides what the migration linter flags. The
// api image cannot import from scripts/, and the linter cannot import
// TypeScript, so the scanner exists twice. This test runs both copies over
// every migration on disk plus a set of edge-case fixtures and fails on any
// difference in statement boundaries or in the transaction-control verdict,
// so one copy cannot be fixed without the other.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from '../src/lib/migration-sql.js';
// @ts-expect-error plain .mjs module without type declarations
import * as js from '../../../scripts/lib/sql-top-level.mjs';

const MIGRATIONS_DIR = resolve(__dirname, '..', '..', '..', 'infra', 'postgres', 'migrations');

const FIXTURES: Record<string, string> = {
  'dollar quoted function body': "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.x = 'a;b'; RETURN NEW; END; $$ LANGUAGE plpgsql;",
  'named dollar tag': 'DO $body$ BEGIN PERFORM 1; END $body$;',
  'nested dollar tags': 'DO $outer$ BEGIN EXECUTE $inner$ SELECT 1; $inner$; END $outer$; SELECT 2;',
  'positional parameter is not a dollar quote': 'PREPARE p AS SELECT $1; EXECUTE p(1);',
  'identifier ending in a dollar sign': 'SELECT a$ FROM t; SELECT 1;',
  'line comment with semicolon': "-- a comment; with a semicolon\nSELECT 'it''s; fine';",
  'E string backslash escape': "SELECT E'\\'; still'; SELECT 2;",
  'e prefixed identifier is not an E string': "SELECT name'x'; SELECT 3;",
  'block comment and quoted identifier': '/* block; comment */ SELECT "weird;ident" FROM t;',
  'unterminated block comment': 'SELECT 1; /* never closed; SELECT 2;',
  'unterminated string': "SELECT 'oops; SELECT 2;",
  'unterminated dollar quote': 'DO $$ BEGIN; SELECT 2;',
  'transaction control mix': '-- header\nBEGIN;\nSELECT 1;\nCOMMIT;\nstart transaction;\nROLLBACK;\nEND;\ncommit work;\nBEGIN ISOLATION LEVEL SERIALIZABLE;',
  'no trailing semicolon': 'SELECT 1; SELECT 2',
  'empty input': '',
};

function bounds(stmts: Array<{ text: string; start: number; end: number }>) {
  return stmts.map((s) => [s.start, s.end, s.text]);
}

/** Statements the TS runner treats as transaction control, by start offset. */
function runnerControl(sql: string): number[] {
  return ts
    .splitTopLevelStatements(sql)
    .filter((s) => ts.isTransactionControl(s.text))
    .map((s) => s.start);
}

/**
 * The linter is deliberately stricter (it also flags END and ROLLBACK), so the
 * invariant is containment: every statement the runner would strip must be
 * one the linter flags. Compare by keyword line.
 */
function lineOf(sql: string, offset: number, text: string): number {
  const lead = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(text)?.[0] ?? '';
  return sql.slice(0, offset + lead.length).split('\n').length;
}

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const cases: Array<[string, string]> = [
  ...Object.entries(FIXTURES).map(([name, sql]) => [`fixture: ${name}`, sql] as [string, string]),
  ...migrationFiles.map((f) => [`migration: ${f}`, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')] as [string, string]),
];

describe('runner and linter SQL scanners agree (issue #149)', () => {
  it('covers every migration on disk', () => {
    expect(migrationFiles.length).toBeGreaterThan(200);
  });

  it.each(cases)('identical statement boundaries for %s', (_name, sql) => {
    expect(bounds(js.splitTopLevelStatements(sql))).toEqual(bounds(ts.splitTopLevelStatements(sql)));
  });

  it.each(cases)('linter flags every statement the runner strips for %s', (_name, sql) => {
    const flagged = new Set(js.findTopLevelTransactionControl(sql).map((f: { line: number }) => f.line));
    const stmts = ts.splitTopLevelStatements(sql);
    for (const start of runnerControl(sql)) {
      const stmt = stmts.find((s) => s.start === start)!;
      expect(flagged.has(lineOf(sql, start, stmt.text))).toBe(true);
    }
  });
});
