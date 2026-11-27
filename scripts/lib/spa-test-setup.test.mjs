import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// node --test scripts/lib/spa-test-setup.test.mjs
// #391: every SPA's vitest setup takes its Testing Library wait and test budgets from the shared
// @bigbluebam/ui/test-setup, so no SPA is left on the 1 s asyncUtilTimeout default (#384).
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSpa, findViolations, sharedBudget, spaApps } from './spa-test-setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const PKG = JSON.stringify({ devDependencies: { '@testing-library/react': '^16.3.0' } });
const GOOD_CONFIG =
  "export default { test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } };\n";
const GOOD_SETUP = [
  "import { configure } from '@testing-library/react';",
  "import { vi } from 'vitest';",
  "import { applySpaTestDefaults } from '@bigbluebam/ui/test-setup';",
  '',
  'applySpaTestDefaults({ configure, vi });',
  '',
].join('\n');

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'spa-setup-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real repo: every SPA test setup uses the shared one', () => {
  assert.deepEqual(findViolations(ROOT), []);
});

test('the detector sees the SPAs (it is not blind)', () => {
  const apps = spaApps(ROOT);
  for (const name of ['bastion', 'frontend', 'helpdesk', 'bay', 'bursar', 'banter']) {
    assert.ok(apps.includes(name), `apps/${name} should be detected as an SPA with tests`);
  }
  assert.ok(apps.length >= 20, `expected 20+ SPAs, found ${apps.length}`);
  assert.ok(!apps.includes('api') && !apps.includes('bastion-api'), 'API packages are not SPAs');
});

test('the shared budget keeps the test timeout above the async wait, and the wait above 1 s', () => {
  const { asyncUtilTimeout, testTimeout } = sharedBudget(ROOT);
  assert.ok(asyncUtilTimeout && asyncUtilTimeout > 1_000, `asyncUtilTimeout ${asyncUtilTimeout}`);
  assert.ok(
    testTimeout && testTimeout > asyncUtilTimeout,
    `testTimeout ${testTimeout} must exceed ${asyncUtilTimeout}`,
  );
});

test('a correctly wired SPA passes, under vite.config.ts as well as vitest.config.ts', () => {
  withFixture(
    { 'package.json': PKG, 'vitest.config.ts': GOOD_CONFIG, 'test/setup.ts': GOOD_SETUP },
    (dir) => assert.deepEqual(checkSpa(dir, 'apps/x'), []),
  );
  withFixture(
    { 'package.json': PKG, 'vite.config.ts': GOOD_CONFIG, 'test/setup.ts': GOOD_SETUP },
    (dir) => assert.deepEqual(checkSpa(dir, 'apps/x'), []),
  );
});

test('the pre-#391 setup (jest-dom only, the 1 s default) is reported', () => {
  withFixture(
    {
      'package.json': PKG,
      'vitest.config.ts': GOOD_CONFIG,
      'test/setup.ts': "import '@testing-library/jest-dom';\n",
    },
    (dir) =>
      assert.deepEqual(checkSpa(dir, 'apps/x'), [
        'apps/x: test/setup.ts does not import applySpaTestDefaults from @bigbluebam/ui/test-setup',
        'apps/x: test/setup.ts does not call applySpaTestDefaults({ configure, vi })',
      ]),
  );
});

test('an SPA with no setup file, or a config that never loads it, is reported', () => {
  withFixture(
    { 'package.json': PKG, 'vite.config.ts': 'export default { base: "/x/" };\n' },
    (dir) =>
      assert.deepEqual(checkSpa(dir, 'apps/x'), [
        'apps/x: vite.config.ts does not list ./test/setup.ts in test.setupFiles',
        'apps/x: test/setup.ts is missing',
      ]),
  );
  withFixture({ 'package.json': PKG, 'test/setup.ts': GOOD_SETUP }, (dir) =>
    assert.deepEqual(checkSpa(dir, 'apps/x'), [
      'apps/x: no vitest/vite config, so test/setup.ts is never loaded',
    ]),
  );
});

test('a setup or config that restates the budget locally (the #384 Bastion-only fix) is reported', () => {
  const ownWait = `${GOOD_SETUP}configure({ asyncUtilTimeout: 20_000 });\n`;
  withFixture(
    { 'package.json': PKG, 'vitest.config.ts': GOOD_CONFIG, 'test/setup.ts': ownWait },
    (dir) =>
      assert.deepEqual(checkSpa(dir, 'apps/x'), [
        'apps/x: test/setup.ts sets asyncUtilTimeout; the SPA test budget lives in @bigbluebam/ui/test-setup',
      ]),
  );
  const ownTimeout =
    "export default { test: { testTimeout: 5_000, setupFiles: ['./test/setup.ts'] } };\n";
  withFixture(
    { 'package.json': PKG, 'vitest.config.ts': ownTimeout, 'test/setup.ts': GOOD_SETUP },
    (dir) =>
      assert.deepEqual(checkSpa(dir, 'apps/x'), [
        'apps/x: vitest.config.ts sets testTimeout; the SPA test budget lives in @bigbluebam/ui/test-setup',
      ]),
  );
});

test('importing the shared module without calling it is reported', () => {
  const importOnly = GOOD_SETUP.replace('applySpaTestDefaults({ configure, vi });', '');
  withFixture(
    { 'package.json': PKG, 'vitest.config.ts': GOOD_CONFIG, 'test/setup.ts': importOnly },
    (dir) =>
      assert.deepEqual(checkSpa(dir, 'apps/x'), [
        'apps/x: test/setup.ts does not call applySpaTestDefaults({ configure, vi })',
      ]),
  );
});
