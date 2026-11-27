#!/usr/bin/env node
/**
 * typecheck-tests.coverage.test.mjs - regression test for scripts/typecheck-tests.mjs discovery (#337).
 *
 * Every apps/* or packages/* directory with a tsconfig.json and a test/ directory must have its
 * test code typechecked SOMEWHERE: either its own tsconfig includes test/, or typecheck-tests.mjs
 * discovers it. Without this guard a new app whose tsconfig excludes test/ (the template every
 * *-api copies) could drop out silently, which is exactly how test/ went unchecked before #337.
 * It also checks a synthetic tree, so a discovery that returns nothing cannot pass by accident.
 *
 * Run via:  node scripts/typecheck-tests.coverage.test.mjs
 * Exit codes: 0 - covered; 1 - a package's test/ is neither in its tsconfig nor discovered.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './typecheck-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// 1. The real tree: every package with test/ is covered by its tsconfig or by discovery.
const discovered = new Set(discover(ROOT).map((p) => `${p.group}/${p.name}`));
let checked = 0;
for (const group of ['apps', 'packages']) {
  for (const name of readdirSync(join(ROOT, group)).sort()) {
    const dir = join(ROOT, group, name);
    if (!existsSync(join(dir, 'tsconfig.json')) || !existsSync(join(dir, 'test'))) continue;
    checked += 1;
    const raw = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    const ownIncludesTest =
      /"include"\s*:\s*\[[^\]]*"test/.test(raw) && !/"exclude"\s*:\s*\[[^\]]*"test"/.test(raw);
    if (!ownIncludesTest && !discovered.has(`${group}/${name}`))
      failures.push(`${group}/${name}: test/ is neither in its tsconfig nor discovered`);
  }
}
if (!discovered.has('apps/bastion-api'))
  failures.push('apps/bastion-api (the package #337 was filed against) is not discovered');

// 2. A synthetic tree: an excluded test/ is found; an included one and a package with no test/ are not.
const tmp = mkdtempSync(join(tmpdir(), 'typecheck-tests-'));
try {
  const pkg = (name, tsconfig, withTest) => {
    const dir = join(tmp, 'apps', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
    if (withTest) mkdirSync(join(dir, 'test'));
  };
  pkg('new-api', { include: ['src'], exclude: ['node_modules', 'dist', 'test'] }, true);
  pkg('covered-api', { include: ['src', 'test'] }, true);
  pkg('no-tests-api', { include: ['src'], exclude: ['test'] }, false);
  const names = discover(tmp).map((p) => p.name);
  if (JSON.stringify(names) !== JSON.stringify(['new-api']))
    failures.push(`synthetic tree: expected [new-api], got ${JSON.stringify(names)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(
  `typecheck-tests coverage: ${checked} package(s) with test/ checked, ${discovered.size} discovered; all covered`,
);
