// #413: scripts/docs/bridge.mjs --apps=<app> used to clear the app's whole light/ and dark/
// screenshot dirs and rebuild them from the shots in the capture manifest, so a partial recapture
// (only 12-sharing and 04-control-detail, say) deleted every other committed image. The bridge now
// replaces only the shots it has; deleting the rest takes an explicit --prune.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const BRIDGE = join(ROOT, 'scripts', 'docs', 'bridge.mjs');

function entry(id, theme, order) {
  return {
    id,
    app: 'demo',
    theme,
    file: `demo/${id}.png`,
    sha256: 'x',
    width: 1,
    height: 1,
    capturedAt: '2026-11-27T00:00:00.000Z',
    doc: { order, label: id },
  };
}

/** A repo-shaped tree with five committed shots and a capture of only two of them (one light, one dark). */
function partialCaptureTree() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-bridge-partial-'));
  const light = join(root, 'docs', 'apps', 'demo', 'screenshots', 'light');
  const dark = join(root, 'docs', 'apps', 'demo', 'screenshots', 'dark');
  mkdirSync(light, { recursive: true });
  mkdirSync(dark, { recursive: true });
  for (const f of ['01-home.png', '04-control-detail.png', '12-sharing.png']) writeFileSync(join(light, f), `old ${f}`);
  for (const f of ['01-home.png', '12-sharing.png']) writeFileSync(join(dark, f), `old dark ${f}`);
  writeFileSync(join(light, 'notes.txt'), 'not a png');

  mkdirSync(join(root, 'screenshots', 'demo'), { recursive: true });
  writeFileSync(join(root, 'screenshots', 'demo', 'demo-control-detail.png'), 'new control detail');
  writeFileSync(join(root, 'screenshots', 'demo', 'demo-sharing-dark.png'), 'new dark sharing');
  writeFileSync(
    join(root, 'screenshots', 'manifest.json'),
    JSON.stringify([entry('demo-control-detail', 'light', 4), entry('demo-sharing-dark', 'dark', 12)]),
  );
  return { root, light, dark };
}

const run = (root, ...extra) =>
  execFileSync(process.execPath, [BRIDGE, `--root=${root}`, '--apps=demo', ...extra], { encoding: 'utf8' });

test('a partial capture replaces only the captured shots and keeps every other committed image', () => {
  const { root, light, dark } = partialCaptureTree();
  try {
    const out = run(root);
    assert.deepEqual(readdirSync(light).sort(), ['01-home.png', '04-control-detail.png', '12-sharing.png', 'notes.txt']);
    assert.deepEqual(readdirSync(dark).sort(), ['01-home.png', '12-sharing.png']);
    assert.equal(readFileSync(join(light, '04-control-detail.png'), 'utf8'), 'new control detail');
    assert.equal(readFileSync(join(dark, '12-sharing.png'), 'utf8'), 'new dark sharing');
    assert.equal(readFileSync(join(light, '01-home.png'), 'utf8'), 'old 01-home.png');
    assert.equal(readFileSync(join(light, '12-sharing.png'), 'utf8'), 'old 12-sharing.png');
    assert.equal(readFileSync(join(dark, '01-home.png'), 'utf8'), 'old dark 01-home.png');
    assert.match(out, /3 committed image\(s\) not in this capture kept/);
    assert.match(out, /\[keep\] docs\/apps\/demo\/screenshots\/light\/01-home\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--prune deletes the committed shots the capture lacks, and only PNGs', () => {
  const { root, light, dark } = partialCaptureTree();
  try {
    const out = run(root, '--prune');
    assert.deepEqual(readdirSync(light).sort(), ['04-control-detail.png', 'notes.txt']);
    assert.deepEqual(readdirSync(dark).sort(), ['12-sharing.png']);
    assert.match(out, /3 pruned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--prune keeps a committed image whose manifest entry has no source file', () => {
  const { root, light } = partialCaptureTree();
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'screenshots', 'manifest.json'), 'utf8'));
    manifest.push(entry('demo-home', 'light', 1));
    writeFileSync(join(root, 'screenshots', 'manifest.json'), JSON.stringify(manifest));
    run(root, '--prune');
    assert.equal(readFileSync(join(light, '01-home.png'), 'utf8'), 'old 01-home.png');
    assert.equal(existsSync(join(light, '12-sharing.png')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--dry-run with --prune reports but deletes nothing', () => {
  const { root, light, dark } = partialCaptureTree();
  try {
    const out = run(root, '--prune', '--dry-run');
    assert.equal(readdirSync(light).length, 4);
    assert.equal(readdirSync(dark).length, 2);
    assert.equal(readFileSync(join(light, '04-control-detail.png'), 'utf8'), 'old 04-control-detail.png');
    assert.match(out, /\[dry-run\]/);
    assert.match(out, /\[prune\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
