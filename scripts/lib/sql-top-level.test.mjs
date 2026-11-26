// node:test suite for scripts/lib/sql-top-level.mjs (issue #131).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findTopLevelTransactionControl, splitTopLevelStatements } from './sql-top-level.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

const MIGRATIONS = join(REPO_ROOT, 'infra', 'postgres', 'migrations');

test('statements inside dollar quotes, strings and comments are not top level', () => {
  const sql = [
    "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.x = 'a;b'; RETURN NEW; END; $$ LANGUAGE plpgsql;",
    'DO $body$ BEGIN PERFORM 1; END $body$;',
    "-- a comment; with a semicolon\nSELECT 'it''s; fine';",
  ].join('\n');
  assert.equal(splitTopLevelStatements(sql).filter((s) => s.text.trim()).length, 3);
  assert.deepEqual(findTopLevelTransactionControl(sql), []);
});

test('flags top-level BEGIN, COMMIT, END and ROLLBACK with their line numbers', () => {
  const sql = '-- header\nBEGIN;\nSELECT 1;\nCOMMIT;\nstart transaction;\nROLLBACK;\nEND;\n';
  assert.deepEqual(
    findTopLevelTransactionControl(sql).map((f) => [f.line, f.statement]),
    [[2, 'BEGIN'], [4, 'COMMIT'], [5, 'START TRANSACTION'], [6, 'ROLLBACK'], [7, 'END']],
  );
});

test('exactly the five known self-transacting migrations are flagged, at the suppressed lines', () => {
  const expected = {
    '0078_reconcile_bam_bearing_drift.sql': [14, 50],
    '0156_permissions_remediate_builtin_defaults.sql': [27, 252],
    '0157_permissions_tighten_member_defaults.sql': [23, 105],
    '0158_permissions_viewer_self_care.sql': [30, 103],
    '0159_permissions_drop_legacy_role_columns.sql': [13, 23],
  };
  const actual = {};
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    const hits = findTopLevelTransactionControl(readFileSync(join(MIGRATIONS, f), 'utf8'));
    if (hits.length) actual[f] = hits.map((h) => h.line);
  }
  assert.deepEqual(actual, expected);
});
