// node:test suite for scripts/lib/migration-lint-rules.mjs (#375, #381).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBareOrgGucCasts,
  findDuplicateSequencePrefixes,
  findSameFileAddDropColumn,
  stripSqlComments,
} from './migration-lint-rules.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

const strip = (sql) => stripSqlComments(sql.split('\n')).join('\n');

test('org-guc-nullif flags every bare spelling of the org GUC uuid cast', () => {
  const sql = [
    'CREATE POLICY a ON t USING (org_id = current_setting(\'app.current_org_id\', true)::uuid);',
    'CREATE POLICY b ON t USING (org_id = current_setting(\'app.current_org_id\')::UUID);',
    "CREATE POLICY c ON t USING (org_id = (current_setting('app.current_org_id'::text, true))::uuid);",
    "CREATE POLICY d ON t USING (org_id = CAST(current_setting('app.current_org_id', TRUE) AS uuid));",
    "  bare constant text := '(current_setting(''app.current_org_id''::text, true))::uuid';",
  ].join('\n');
  assert.deepEqual(findBareOrgGucCasts(strip(sql)).map((f) => f.line), [1, 2, 3, 4, 5]);
});

test('org-guc-nullif accepts the NULLIF form, text comparisons and comments', () => {
  const sql = [
    "CREATE POLICY a ON t USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);",
    "CREATE POLICY b ON t USING (org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid);",
    "CREATE POLICY c ON t USING (org_id::text = current_setting('app.current_org_id', true));",
    "-- the old form was current_setting('app.current_org_id', true)::uuid",
    "/* current_setting('app.current_org_id')::uuid */ SELECT 1;",
    "v_org := nullif(current_setting('app.current_org_id', true), '');",
  ].join('\n');
  assert.deepEqual(findBareOrgGucCasts(strip(sql)), []);
});

test('drop-column-separate-release flags a drop on a table the same file adds to', () => {
  const sql = [
    'ALTER TABLE bay_review_links ADD COLUMN IF NOT EXISTS token_hash VARCHAR(64);',
    'UPDATE bay_review_links SET token_hash = md5(token);',
    'DO $$',
    'BEGIN',
    '  ALTER TABLE bay_review_links DROP COLUMN IF EXISTS token;',
    'END $$;',
  ].join('\n');
  assert.deepEqual(findSameFileAddDropColumn(strip(sql)), [
    { line: 5, table: 'bay_review_links', column: 'token' },
  ]);
});

test('drop-column-separate-release handles multi-clause ALTERs and schema-qualified names', () => {
  const sql = [
    'ALTER TABLE public."widgets"',
    '  ADD COLUMN IF NOT EXISTS b int,',
    '  DROP COLUMN IF EXISTS a;',
  ].join('\n');
  assert.deepEqual(findSameFileAddDropColumn(strip(sql)), [{ line: 3, table: 'widgets', column: 'a' }]);
});

test('drop-column-separate-release allows a lone contract migration and drops on other tables', () => {
  const contractOnly = 'ALTER TABLE bay_assets DROP COLUMN IF EXISTS thumbnail_key;';
  assert.deepEqual(findSameFileAddDropColumn(strip(contractOnly)), []);
  const otherTable = [
    'ALTER TABLE a ADD COLUMN IF NOT EXISTS x int;',
    'ALTER TABLE b DROP COLUMN IF EXISTS y;',
    '-- ALTER TABLE a DROP COLUMN IF EXISTS z;',
  ].join('\n');
  assert.deepEqual(findSameFileAddDropColumn(strip(otherTable)), []);
});

test('lint-migrations passes on the tree (historical hits are suppressed off-file)', () => {
  // Throws (non-zero exit) on any violation, including new rule hits. Zero
  // warnings too: a second OFF_FILE_SUPPRESSIONS key for the same file
  // silently replaces the first and resurfaces its suppressed warnings.
  const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'lint-migrations.mjs')], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  assert.match(out, /0 violation\(s\), 0 warning\(s\)/);
});

test('OFF_FILE_SUPPRESSIONS names each file once (a second key silently replaces the first)', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'lint-migrations.mjs'), 'utf8');
  const keys = [...src.matchAll(/^ {2}'([0-9]{4}_[a-z0-9_]+\.sql)':/gm)].map((m) => m[1]);
  assert.ok(keys.length > 10, 'expected to find the suppression map keys');
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

test('unique-sequence-prefix groups every file that shares a 4-digit prefix', () => {
  assert.deepEqual(
    findDuplicateSequencePrefixes([
      '0360_b.sql',
      '0001_a.sql',
      '0360_a.sql',
      '0141_x.sql',
      '0141_y.sql',
      '0141_z.sql',
      '0002_b.sql',
      'README.md',
    ]),
    [
      { prefix: '0141', files: ['0141_x.sql', '0141_y.sql', '0141_z.sql'] },
      { prefix: '0360', files: ['0360_a.sql', '0360_b.sql'] },
    ],
  );
  assert.deepEqual(findDuplicateSequencePrefixes(['0001_a.sql', '0002_a.sql']), []);
});

test('the tree has exactly the three historical duplicate prefixes, none new', () => {
  const files = readdirSync(join(REPO_ROOT, 'infra', 'postgres', 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.deepEqual(
    findDuplicateSequencePrefixes(files).map((d) => d.prefix),
    ['0141', '0226', '0227'],
  );
});

function lintFixture(names) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-mig-'));
  for (const n of names) {
    const body = [`-- ${n}`, '-- Why: fixture.', '-- Client impact: none.', '', 'SELECT 1;', ''].join('\n');
    writeFileSync(join(dir, n), body);
  }
  try {
    const out = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'lint-migrations.mjs')], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, LINT_MIGRATIONS_DIR: dir },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('lint-migrations: the suppressed historical pair passes, a new duplicate of it fails (#386)', () => {
  const historical = ['0141_book_event_livekit_room.sql', '0141_users_created_by.sql', '0142_next.sql'];
  const ok = lintFixture(historical);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /0 violation\(s\)/);

  const bad = lintFixture([...historical, '0141_new_feature.sql']);
  assert.equal(bad.code, 1);
  const hits = bad.out.split('\n').filter((l) => l.includes('[unique-sequence-prefix]'));
  assert.equal(hits.length, 1, bad.out);
  assert.match(hits[0], /^0141_new_feature\.sql:0 {2}\[unique-sequence-prefix\] sequence 0141 is also used by /);
});

test('lint-migrations: a brand-new pair is flagged on both files (the 0360 merge of 2026-11-27)', () => {
  const r = lintFixture(['0359_a.sql', '0360_api_key_legacy.sql', '0360_projects_ensure_key.sql']);
  assert.equal(r.code, 1);
  const hits = r.out.split('\n').filter((l) => l.includes('[unique-sequence-prefix]'));
  assert.deepEqual(
    hits.map((l) => l.split(':')[0]),
    ['0360_api_key_legacy.sql', '0360_projects_ensure_key.sql'],
  );
  assert.match(r.out, /2 violation\(s\)/);
});
