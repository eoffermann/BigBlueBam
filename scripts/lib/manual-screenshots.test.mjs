// Regression test for #380: the manual embedded 10 screenshots (Basis, Bin,
// Bursar) that did not exist under site/public, because the site copies had
// been hand-renamed or flattened, and docs:manual:check only printed
// "(10 unreadable)" and passed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { staleSiteScreenshots, syncSiteScreenshots } from '../docs/sync-site-screenshots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every manual image resolves under site/public and the check passes', () => {
  const manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'src', 'content', 'manual.generated.json'), 'utf8'));
  const missing = [];
  for (const e of manual) {
    for (const m of e.markdown.matchAll(/\]\((\/screenshots\/[^)]+\.png)\)/g)) {
      if (!fs.existsSync(path.join(ROOT, 'site', 'public', m[1]))) missing.push(m[1]);
    }
  }
  assert.deepEqual(missing, []);
  const r = spawnSync(process.execPath, ['scripts/docs/build-manual.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /unreadable|missing or/);
});

test('site copies of docs screenshots are byte-identical with identical names', () => {
  assert.deepEqual(staleSiteScreenshots(ROOT), []);
});

// Known gaps, each tracked by an open issue. Delete an entry once its image lands.
const KNOWN_MISSING = new Set([
  // #382: Bastion screenshots were never captured.
  'bastion-section.tsx: /screenshots/bastion/light/01-readiness.png',
  'bastion-section.tsx: /screenshots/bastion/light/06-what-to-fix-first.png',
  'bastion-section.tsx: /screenshots/bastion/light/04-control-detail.png',
  'bastion-section.tsx: /screenshots/bastion/dark/01-readiness.png',
]);

test('marketing app sections only reference screenshots that exist', () => {
  const dir = path.join(ROOT, 'site', 'src', 'components', 'sections');
  const missing = [];
  const found = new Set();
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/["'`](\/screenshots\/[a-z0-9_/.-]+\.png)["'`]/gi)) {
      const key = `${f}: ${m[1]}`;
      if (fs.existsSync(path.join(ROOT, 'site', 'public', m[1]))) continue;
      if (KNOWN_MISSING.has(key)) found.add(key);
      else missing.push(key);
    }
  }
  assert.deepEqual(missing, []);
  // A stale allowlist entry (image now present) must be removed.
  assert.deepEqual([...KNOWN_MISSING].filter((k) => !found.has(k)), []);
});

test('sync detects and repairs a missing copy in a scratch tree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bbb-shots-'));
  try {
    const src = path.join(tmp, 'docs', 'apps', 'demo', 'screenshots', 'light');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'site', 'public'), { recursive: true });
    fs.writeFileSync(path.join(src, '01-home.png'), 'x');
    assert.deepEqual(staleSiteScreenshots(tmp), ['demo/light/01-home.png']);
    assert.deepEqual(syncSiteScreenshots(tmp), ['demo/light/01-home.png']);
    assert.deepEqual(staleSiteScreenshots(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
