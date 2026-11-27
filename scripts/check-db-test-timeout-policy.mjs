#!/usr/bin/env node
// #385: a DB-backed vitest suite must run under the workspace DB-test budget in
// vitest.db-policy.mjs, not vitest's 5 s default (bay-api's routes.db.test.ts timed out under load
// with no real failure) and not a per-package number that drifts. A package has DB-backed suites if
// it holds a `*.db.test.ts` file or any test under a `test/db/` directory (bastion-api's layout).
// Every such package must have a vitest.workspace file that imports the shared policy module.
//
// Run directly: node scripts/check-db-test-timeout-policy.mjs   (exits 1 on a violation)
// Tested by scripts/lib/db-test-timeout-policy.test.mjs, which also runs it against the real repo.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_FILES = ['vitest.workspace.ts', 'vitest.workspace.mts', 'vitest.workspace.mjs', 'vitest.workspace.js'];
const CONFIG_FILES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.mjs', 'vitest.config.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);
const POLICY_IMPORT = /from\s+['"](?:\.\.\/)+vitest\.db-policy\.mjs['"]/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** Test files in a package that talk to a real database, as package-relative POSIX paths. */
export function dbSuites(pkgDir) {
  return walk(pkgDir)
    .map((f) => relative(pkgDir, f).split(sep).join('/'))
    .filter((p) => /\.db\.test\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test\/db\/.+\.test\.[cm]?[jt]sx?$/.test(p));
}

/** Every workspace package directory (apps/* and packages/*). */
export function packageDirs(root) {
  const dirs = [];
  for (const group of ['apps', 'packages']) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const e of readdirSync(g, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(g, e.name, 'package.json'))) dirs.push(join(g, e.name));
    }
  }
  return dirs;
}

/** Problems for one package; [] when it has no DB suites or follows the policy. */
export function checkPackage(pkgDir, label = pkgDir) {
  const suites = dbSuites(pkgDir);
  if (suites.length === 0) return [];
  const problems = [];
  const ws = WORKSPACE_FILES.map((f) => join(pkgDir, f)).find((f) => existsSync(f));
  if (!ws) {
    const listed = `${suites.slice(0, 3).join(', ')}${suites.length > 3 ? ', ...' : ''}`;
    problems.push(
      `${label}: has DB-backed suites (${listed}) but no vitest.workspace.ts; build its projects with dbTestProjects() from vitest.db-policy.mjs`,
    );
    return problems;
  }
  const text = readFileSync(ws, 'utf8');
  if (!POLICY_IMPORT.test(text)) {
    problems.push(`${label}: ${relative(pkgDir, ws)} does not import the workspace DB-test policy (vitest.db-policy.mjs)`);
  }
  // The policy's DB include (DB_TEST_INCLUDE) is test/**/*.db.test.ts plus test/db/**/*.test.ts;
  // a DB suite anywhere else would land in the unit project under the unit budget.
  for (const s of suites) {
    const covered = (s.startsWith('test/') && /\.db\.test\.ts$/.test(s)) || /^test\/db\/.+\.test\.ts$/.test(s);
    if (!covered) {
      problems.push(`${label}: ${s} is not matched by the db project (move it under test/ as *.db.test.ts)`);
    }
  }
  // In workspace mode the inline projects do not inherit the root config's timeouts, so a timeout
  // left there is dead and misleading.
  for (const c of CONFIG_FILES) {
    const p = join(pkgDir, c);
    if (existsSync(p) && /\b(testTimeout|hookTimeout)\s*:/.test(readFileSync(p, 'utf8'))) {
      problems.push(`${label}: ${c} sets a timeout the workspace projects ignore; set it in vitest.workspace.ts`);
    }
  }
  return problems;
}

export function findViolations(root) {
  return packageDirs(root).flatMap((d) => checkPackage(d, relative(root, d).split(sep).join('/')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const problems = findViolations(root);
  for (const p of problems) console.error(`db-test-timeout-policy: ${p}`);
  console.log(`db-test-timeout-policy: ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}
