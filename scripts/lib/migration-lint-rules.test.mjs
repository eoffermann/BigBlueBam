// node:test suite for scripts/lib/migration-lint-rules.mjs (#381).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { findBareOrgGucCasts, stripSqlComments } from './migration-lint-rules.mjs';
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
