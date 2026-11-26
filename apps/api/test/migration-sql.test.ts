import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isTransactionControl,
  splitTopLevelStatements,
  stripTopLevelTransactionControl,
} from '../src/lib/migration-sql.js';

const MIGRATIONS_DIR = resolve(__dirname, '..', '..', '..', 'infra', 'postgres', 'migrations');

const SELF_TRANSACTING = [
  '0078_reconcile_bam_bearing_drift.sql',
  '0156_permissions_remediate_builtin_defaults.sql',
  '0157_permissions_tighten_member_defaults.sql',
  '0158_permissions_viewer_self_care.sql',
  '0159_permissions_drop_legacy_role_columns.sql',
];

describe('splitTopLevelStatements', () => {
  it('does not split inside dollar quotes, strings, or comments', () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN NEW.x = 'a;b'; RETURN NEW; END; $$ LANGUAGE plpgsql;",
      'DO $body$ BEGIN PERFORM 1; END $body$;',
      "-- a comment; with a semicolon\nSELECT 'it''s; fine', E'\\'; still';",
      '/* block; comment */ SELECT "weird;ident" FROM t;',
    ].join('\n');
    const stmts = splitTopLevelStatements(sql).filter((s) => s.text.trim());
    expect(stmts).toHaveLength(4);
  });
});

describe('isTransactionControl', () => {
  it.each(['BEGIN', 'begin', ' BEGIN TRANSACTION ', 'START TRANSACTION', 'COMMIT', 'commit work', '-- c\nBEGIN'])(
    'treats %j as transaction control',
    (s) => expect(isTransactionControl(s)).toBe(true),
  );
  it.each(['BEGIN ATOMIC SELECT 1', 'ROLLBACK', 'END', 'SELECT 1', 'COMMIT PREPARED \'x\''])(
    'leaves %j alone',
    (s) => expect(isTransactionControl(s)).toBe(false),
  );
});

describe('stripTopLevelTransactionControl', () => {
  it('removes top-level BEGIN/COMMIT and keeps everything else, line count included', () => {
    const sql = '-- header\nBEGIN;\nCREATE TABLE IF NOT EXISTS t (id int);\nDO $$ BEGIN PERFORM 1; END $$;\nCOMMIT;\n';
    const { sql: out, removed } = stripTopLevelTransactionControl(sql);
    expect(removed).toBe(2);
    expect(out).toBe('-- header\n\nCREATE TABLE IF NOT EXISTS t (id int);\nDO $$ BEGIN PERFORM 1; END $$;\n\n');
    expect(out.split('\n')).toHaveLength(sql.split('\n').length);
  });

  it('is a no-op for a file without transaction control', () => {
    const sql = 'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$\nBEGIN\n  RETURN 1;\nEND;\n$$ LANGUAGE plpgsql;\n';
    expect(stripTopLevelTransactionControl(sql)).toEqual({ sql, removed: 0 });
  });

  it.each(SELF_TRANSACTING)('strips exactly one BEGIN and one COMMIT from %s', (file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const { sql: out, removed } = stripTopLevelTransactionControl(sql);
    expect(removed).toBe(2);
    expect(splitTopLevelStatements(out).some((s) => isTransactionControl(s.text))).toBe(false);
    // Only the two keywords were removed.
    expect(sql.length - out.length).toBe('BEGIN;'.length + 'COMMIT;'.length);
  });

  it('finds top-level transaction control in no other migration', () => {
    const offenders = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => stripTopLevelTransactionControl(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')).removed > 0);
    expect(offenders.sort()).toEqual([...SELF_TRANSACTING].sort());
  });
});
