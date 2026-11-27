// #400: scripts/docs/bridge.mjs (screenshot list) and scripts/docs/extract.mjs
// (route/schema counts) both wrote docs/apps/<app>/meta.json, so its shape
// depended on which stage ran last. One file, one writer: extract owns
// meta.json, the screenshot stages own screenshots.json.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  APP_META_FILE,
  APP_SCREENSHOTS_FILE,
  appMetaPath,
  appScreenshotsPath,
  isAppMeta,
  readAppMeta,
} from '../docs/lib/app-doc-files.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const BRIDGE = join(ROOT, 'scripts', 'docs', 'bridge.mjs');

const COUNTS = {
  app: 'demo',
  route_files: 3,
  schema_modules: 2,
  mcp_tool_count: 5,
  src_hash: 'abc',
  generated_at: '2026-11-27T00:00:00.000Z',
};

test('bridge writes the screenshot list to screenshots.json and never touches meta.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'bbb-bridge-'));
  try {
    mkdirSync(join(root, 'screenshots', 'demo'), { recursive: true });
    writeFileSync(join(root, 'screenshots', 'demo', 'demo-home.png'), 'png-bytes');
    writeFileSync(
      join(root, 'screenshots', 'manifest.json'),
      JSON.stringify([
        {
          id: 'demo-home',
          app: 'demo',
          theme: 'light',
          file: 'demo/demo-home.png',
          sha256: 'deadbeef',
          width: 10,
          height: 20,
          capturedAt: '2026-11-27T00:00:00.000Z',
          doc: { order: 1, label: 'Home' },
        },
      ]),
    );
    mkdirSync(join(root, 'docs', 'apps', 'demo'), { recursive: true });
    const metaBefore = `${JSON.stringify(COUNTS, null, 2)}\n`;
    writeFileSync(appMetaPath(root, 'demo'), metaBefore);

    execFileSync(process.execPath, [BRIDGE, `--root=${root}`], { encoding: 'utf8' });

    assert.equal(readFileSync(appMetaPath(root, 'demo'), 'utf8'), metaBefore, 'meta.json is extract-owned');
    assert.deepEqual(readAppMeta(root, 'demo'), COUNTS);
    const shots = JSON.parse(readFileSync(appScreenshotsPath(root, 'demo'), 'utf8'));
    assert.ok(Array.isArray(shots));
    assert.deepEqual(
      shots.map((s) => [s.id, s.label, s.theme, s.file.split('\\').join('/')]),
      [['01-home', 'Home', 'light', 'docs/apps/demo/screenshots/light/01-home.png']],
    );
    assert.equal(readFileSync(join(root, 'docs', 'apps', 'demo', 'screenshots', 'light', '01-home.png'), 'utf8'), 'png-bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readAppMeta refuses a screenshot array in meta.json instead of rendering undefined counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'bbb-meta-'));
  try {
    mkdirSync(join(root, 'docs', 'apps', 'demo'), { recursive: true });
    writeFileSync(appMetaPath(root, 'demo'), JSON.stringify([{ id: '01-home' }]));
    assert.throws(() => readAppMeta(root, 'demo'), /not the extract\.mjs counts object/);
    assert.equal(isAppMeta(COUNTS), true);
    assert.equal(isAppMeta([]), false);
    assert.equal(isAppMeta(null), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the file names are encoded once: no other docs-pipeline source spells them as a string literal', () => {
  const owner = join(ROOT, 'scripts', 'docs', 'lib', 'app-doc-files.mjs');
  const sources = [
    ...walk(join(ROOT, 'scripts', 'docs')),
    ...walk(join(ROOT, 'packages', 'docs-capture', 'src')),
  ].filter((f) => f !== owner);
  const literal = new RegExp(`['"](?:${APP_META_FILE}|${APP_SCREENSHOTS_FILE})['"]`.replace(/\./g, '\\.'));
  const offenders = sources
    .filter((f) => literal.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f).split('\\').join('/'));
  // The TypeScript capture package cannot import the .mjs module, so it keeps
  // one mirrored constant; it must match APP_SCREENSHOTS_FILE exactly.
  assert.deepEqual(offenders, ['packages/docs-capture/src/helpers.ts']);
  const helpers = readFileSync(join(ROOT, 'packages', 'docs-capture', 'src', 'helpers.ts'), 'utf8');
  assert.match(helpers, new RegExp(`export const APP_SCREENSHOTS_FILE = '${APP_SCREENSHOTS_FILE.replace('.', '\\.')}';`));
  assert.doesNotMatch(helpers, /'meta\.json'/);
});
