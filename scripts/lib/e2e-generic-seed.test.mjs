// #249: the e2e "seed e2e ..." setup steps write generic placeholder data into the admin's org.
// They must run only for the generic e2e admin (never for Skipper in the GILLIGAN org), and the
// helpdesk step must name its org, since helpdesk-api otherwise falls back to the first
// helpdesk_settings row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const setupSrc = readFileSync(join(ROOT, 'apps/e2e/src/auth/auth.setup.ts'), 'utf8');
const usersSrc = readFileSync(join(ROOT, 'apps/e2e/src/auth/test-users.ts'), 'utf8');

test('every "seed e2e" step goes through seedSetup, which skips unless GENERIC_SEED_ALLOWED', () => {
  const steps = [...setupSrc.matchAll(/^(\w+)\('seed e2e [^']*'/gm)].map((m) => m[1]);
  assert.ok(steps.length >= 10, `found ${steps.length} seed steps`);
  assert.deepEqual([...new Set(steps)], ['seedSetup']);
  assert.match(setupSrc, /function seedSetup[\s\S]{0,300}setup\.skip\(\s*!GENERIC_SEED_ALLOWED/);
});

test('GENERIC_SEED_ALLOWED is true only for the generic e2e admin (or an explicit opt-in)', () => {
  assert.match(usersSrc, /DEFAULT_E2E_ADMIN_EMAIL = 'e2e-admin@bigbluebam\.test'/);
  assert.match(usersSrc, /GENERIC_SEED_ALLOWED =\s*TEST_USERS\.admin\.email\.toLowerCase\(\) === DEFAULT_E2E_ADMIN_EMAIL/);
});

test('the helpdesk seed names its org with X-Org-Slug', () => {
  const step = setupSrc.slice(setupSrc.indexOf("seedSetup('seed e2e helpdesk"));
  assert.match(step, /extraHTTPHeaders: \{ 'X-Org-Slug': orgSlug \}/);
});
