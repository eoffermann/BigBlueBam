// #412: one session check for every SPA.
//
// Each SPA's auth store used to treat ANY failed /auth/me (a 429 from the rate limiter, a 5xx, a
// dropped connection) as "signed out" and show "Please log in". The rule now lives once in
// packages/ui/session.ts (loadSession): only a 401 signs out; everything else keeps the session and
// retries behind the shared Reconnecting notice. This test keeps every SPA on it:
//   1. every SPA auth store that has fetchMe calls loadSession;
//   2. no SPA auth store hand-rolls the old "any non-2xx means signed out" check;
//   3. every SPA main.tsx mounts <SessionReconnectingNotice />.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** SPAs = apps with src/stores/auth.store.ts that defines fetchMe. */
function spaStores() {
  const out = [];
  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    const p = join(repoRoot, 'apps', app, 'src', 'stores', 'auth.store.ts');
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    if (/fetchMe\s*:/.test(text)) out.push({ app, text });
  }
  return out;
}

/** The old shape: a non-ok /auth/me response (or any catch) turned straight into signed-out. */
export function handRollsSignedOut(text) {
  return /if\s*\(\s*!\s*res\.ok\s*\)\s*throw new Error\(\s*['"]Not authenticated['"]\s*\)/.test(text);
}

test('the detector spots the old any-failure-is-signed-out shape', () => {
  assert.equal(handRollsSignedOut("if (!res.ok) throw new Error('Not authenticated');"), true);
  assert.equal(handRollsSignedOut("const session = await loadSession(fetchSessionAttempt('/b3/api/auth/me'));"), false);
});

test('every SPA auth store routes fetchMe through loadSession', () => {
  const stores = spaStores();
  assert.ok(stores.length >= 20, `expected the SPAs, found ${stores.length}`);
  const missing = stores.filter(({ text }) => !/\bloadSession\s*\(/.test(text) || !text.includes("'@bigbluebam/ui/session'"));
  assert.deepEqual(
    missing.map((s) => s.app),
    [],
    'these SPA auth stores do not use loadSession from @bigbluebam/ui/session',
  );
});

test('no SPA auth store treats a non-2xx /auth/me as signed out by hand', () => {
  const offenders = spaStores().filter(({ text }) => handRollsSignedOut(text));
  assert.deepEqual(offenders.map((s) => s.app), []);
});

test('every SPA mounts the shared Reconnecting notice', () => {
  const missing = spaStores()
    .map(({ app }) => app)
    .filter((app) => {
      const main = join(repoRoot, 'apps', app, 'src', 'main.tsx');
      return !existsSync(main) || !/<SessionReconnectingNotice\s*\/>/.test(readFileSync(main, 'utf8'));
    });
  assert.deepEqual(missing, [], 'these SPAs do not render <SessionReconnectingNotice />');
});
