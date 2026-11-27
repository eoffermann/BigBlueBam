// #391: every SPA's vitest run takes its Testing Library wait and test budgets from the one shared
// setup, @bigbluebam/ui/test-setup (packages/ui/test-setup.ts). #384 raised asyncUtilTimeout in
// Bastion alone; every other SPA kept the 1 s default and the same CI false-reds. This finds the
// SPA test setups that do not use the shared one.
//
// An SPA here is an apps/* package that depends on @testing-library/react. For each, the vitest
// config (vitest.config.* if present, else vite.config.*) must list ./test/setup.ts in setupFiles,
// and test/setup.ts must import applySpaTestDefaults from @bigbluebam/ui/test-setup and call it.
// Neither may restate the budget (asyncUtilTimeout, testTimeout, hookTimeout): it has one home.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHARED_MODULE = '@bigbluebam/ui/test-setup';
export const SETUP_FILE = 'test/setup.ts';
const CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
];

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** True when the package at `dir` depends on @testing-library/react. */
export function isSpaWithTests(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) return false;
  return Boolean(
    pkg.dependencies?.['@testing-library/react'] || pkg.devDependencies?.['@testing-library/react'],
  );
}

/** apps/<name> directory names that are SPAs in the sense above, sorted. */
export function spaApps(root) {
  const apps = join(root, 'apps');
  return readdirSync(apps, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isSpaWithTests(join(apps, e.name)))
    .map((e) => e.name)
    .sort();
}

/** The config file vitest loads for the package (vitest.config.* wins over vite.config.*). */
export function vitestConfigFile(dir) {
  return CONFIG_NAMES.find((n) => existsSync(join(dir, n))) ?? null;
}

const SETUP_FILES_RE = /setupFiles\s*:\s*\[[^\]]*['"](?:\.\/)?test\/setup\.ts['"]/;
const BUDGET_RE = /\b(asyncUtilTimeout|testTimeout|hookTimeout)\s*:/;
const IMPORT_RE = new RegExp(
  String.raw`import\s*\{[^}]*\bapplySpaTestDefaults\b[^}]*\}\s*from\s*['"]${SHARED_MODULE.replace(/[/.]/g, '\\$&')}['"]`,
);
const CALL_RE = /^\s*applySpaTestDefaults\(\s*\{\s*configure\s*,\s*vi\s*\}\s*\);?\s*$/m;

/** Problems for one SPA package directory; `label` prefixes each message. */
export function checkSpa(dir, label) {
  const problems = [];
  const config = vitestConfigFile(dir);
  if (!config) {
    problems.push(`${label}: no vitest/vite config, so ${SETUP_FILE} is never loaded`);
  } else {
    const src = readFileSync(join(dir, config), 'utf8');
    if (!SETUP_FILES_RE.test(src))
      problems.push(`${label}: ${config} does not list ./${SETUP_FILE} in test.setupFiles`);
    const budget = src.match(BUDGET_RE);
    if (budget)
      problems.push(
        `${label}: ${config} sets ${budget[1]}; the SPA test budget lives in ${SHARED_MODULE}`,
      );
  }
  const setupPath = join(dir, SETUP_FILE);
  if (!existsSync(setupPath)) {
    problems.push(`${label}: ${SETUP_FILE} is missing`);
    return problems;
  }
  const setup = readFileSync(setupPath, 'utf8');
  if (!IMPORT_RE.test(setup))
    problems.push(
      `${label}: ${SETUP_FILE} does not import applySpaTestDefaults from ${SHARED_MODULE}`,
    );
  if (!CALL_RE.test(setup))
    problems.push(`${label}: ${SETUP_FILE} does not call applySpaTestDefaults({ configure, vi })`);
  const budget = setup.match(BUDGET_RE);
  if (budget)
    problems.push(
      `${label}: ${SETUP_FILE} sets ${budget[1]}; the SPA test budget lives in ${SHARED_MODULE}`,
    );
  return problems;
}

export function findViolations(root) {
  return spaApps(root).flatMap((name) => checkSpa(join(root, 'apps', name), `apps/${name}`));
}

/** The numeric budget constants declared in packages/ui/test-setup.ts. */
export function sharedBudget(root) {
  const src = readFileSync(join(root, 'packages', 'ui', 'test-setup.ts'), 'utf8');
  const num = (name) => {
    const m = src.match(new RegExp(String.raw`export const ${name}\s*=\s*([\d_]+)\s*;`));
    return m ? Number(m[1].replace(/_/g, '')) : null;
  };
  return {
    asyncUtilTimeout: num('SPA_ASYNC_UTIL_TIMEOUT_MS'),
    testTimeout: num('SPA_TEST_TIMEOUT_MS'),
  };
}
