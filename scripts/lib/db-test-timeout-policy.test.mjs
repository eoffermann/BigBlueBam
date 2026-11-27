// node --test scripts/lib/db-test-timeout-policy.test.mjs
// #385: every package with a DB-backed vitest suite runs it under the workspace DB budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage, dbSuites, findViolations } from '../check-db-test-timeout-policy.mjs';
import { DB_HOOK_TIMEOUT_MS, DB_TEST_INCLUDE, DB_TEST_TIMEOUT_MS, dbTestProjects } from '../../vitest.db-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'db-policy-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const POLICY_WS = "import { dbTestProjects } from '../../vitest.db-policy.mjs';\nexport default dbTestProjects({});\n";

test('the real repo: every package with a DB-backed suite adopts the policy', () => {
  assert.deepEqual(findViolations(ROOT), []);
});

test('the real repo has DB suites in the packages the policy was applied to (detector is not blind)', () => {
  for (const p of ['apps/bay-api', 'apps/api', 'apps/bastion-api', 'apps/worker']) {
    assert.ok(dbSuites(join(ROOT, p)).length > 0, `${p} should have DB-backed suites`);
  }
});

test('a *.db.test.ts in a package without the policy fails (the bay-api 5 s default)', () => {
  const dir = fixture({ 'package.json': '{}', 'test/routes.db.test.ts': '' });
  try {
    const problems = checkPackage(dir, 'apps/x');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /apps\/x: has DB-backed suites \(test\/routes\.db\.test\.ts\) but no vitest\.workspace\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workspace that does not import the policy, or a dead root timeout, is reported', () => {
  const dir = fixture({
    'package.json': '{}',
    'test/a.db.test.ts': '',
    'vitest.workspace.ts': 'export default [{ test: { testTimeout: 5_000 } }];\n',
    'vitest.config.ts': 'export default { test: { testTimeout: 60_000 } };\n',
  });
  try {
    const problems = checkPackage(dir, 'apps/x');
    assert.equal(problems.length, 2);
    assert.match(problems[0], /does not import the workspace DB-test policy/);
    assert.match(problems[1], /vitest\.config\.ts sets a timeout the workspace projects ignore/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a DB suite outside the db project include (here, under src/) is reported', () => {
  const dir = fixture({
    'package.json': '{}',
    'src/a.db.test.ts': '',
    'vitest.workspace.ts': POLICY_WS,
  });
  try {
    const problems = checkPackage(dir, 'apps/x');
    assert.deepEqual(problems.map((p) => p.split(': ')[1]), [
      'src/a.db.test.ts is not matched by the db project (move it under test/ as *.db.test.ts)',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a test/db/ suite (bastion-api, beacon-api layout) counts as DB-backed', () => {
  const missing = fixture({ 'package.json': '{}', 'test/db/a.test.ts': '' });
  try {
    assert.match(checkPackage(missing, 'apps/x')[0], /has DB-backed suites \(test\/db\/a\.test\.ts\)/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
});

test('a package that follows the policy, or has no DB suite, passes', () => {
  const ok = fixture({
    'package.json': '{}',
    'test/a.db.test.ts': '',
    'test/db/b.test.ts': '',
    'test/u.test.ts': '',
    'vitest.workspace.ts': POLICY_WS,
  });
  const none = fixture({ 'package.json': '{}', 'test/u.test.ts': '' });
  try {
    assert.deepEqual(checkPackage(ok), []);
    assert.deepEqual(checkPackage(none), []);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

test('dbTestProjects: unit keeps the package options minus DB suites; db gets the DB budget, which cannot be lowered', () => {
  const [unit, db] = dbTestProjects(
    { testTimeout: 60_000, hookTimeout: 60_000, globals: true, include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
    { db: { testTimeout: 5_000, globalSetup: ['g.ts'] } },
  );
  assert.equal(unit.test.name, 'unit');
  assert.deepEqual(unit.test.include, ['src/**/*.test.ts', 'test/**/*.test.ts']);
  assert.equal(unit.test.testTimeout, 60_000);
  for (const g of DB_TEST_INCLUDE) assert.ok(unit.test.exclude.includes(g));
  assert.ok(unit.test.exclude.includes('**/node_modules/**'));
  assert.equal(db.test.name, 'db');
  assert.deepEqual(db.test.include, DB_TEST_INCLUDE);
  assert.equal(db.test.globals, true);
  assert.deepEqual(db.test.globalSetup, ['g.ts']);
  assert.equal(db.test.testTimeout, DB_TEST_TIMEOUT_MS);
  assert.equal(db.test.hookTimeout, DB_HOOK_TIMEOUT_MS);
  assert.ok(DB_TEST_TIMEOUT_MS >= 300_000 && DB_HOOK_TIMEOUT_MS >= 300_000);
});
