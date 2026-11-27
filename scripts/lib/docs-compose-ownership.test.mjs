// #398: docs:compose (and so the one-shot docs:generate) used to replace a
// hand-written docs/apps/<app>/guide.md with a stub whenever the app had no
// _narrative.md, so the pipeline could not be run end to end and agents ran
// stages piecemeal. Compose now writes only files it generated (marked with
// GENERATED_MARKER, or the legacy `generated:` front-matter key), skips apps
// with no source partial instead of inventing stubs, and leaves a file alone
// when only its timestamp would change.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_MARKER,
  isGenerated,
  isUnchanged,
  planOutput,
} from '../docs/lib/generated-marker.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const COMPOSE = join(ROOT, 'scripts', 'docs', 'compose.mjs');

const HAND_GUIDE = '---\ntitle: "Hand Guide"\napp: hand\n---\n\n# Hand\n\nWritten by a person.\n';
const LEGACY_GUIDE =
  '---\ntitle: "Old Guide"\napp: old\ngenerated: "2026-06-24T21:06:05.284Z"\n---\n\n# Old\n';

test('isGenerated: marker or legacy front-matter key means compose owns the file', () => {
  assert.equal(isGenerated(HAND_GUIDE), false);
  assert.equal(isGenerated(LEGACY_GUIDE), true);
  assert.equal(isGenerated(`---\ntitle: x\n---\n\n${GENERATED_MARKER}\n`), true);
  assert.equal(isGenerated(HAND_GUIDE.replace(/\n/g, '\r\n')), false);
  assert.equal(isGenerated(LEGACY_GUIDE.replace(/\n/g, '\r\n')), true);
  // "generated:" in the body is prose, not front matter.
  assert.equal(isGenerated(`${HAND_GUIDE}\ngenerated: "2026-01-01"\n`), false);
});

test('planOutput never plans a write over a hand-written file', () => {
  assert.equal(planOutput({ existing: HAND_GUIDE, source: null }), 'handwritten');
  assert.equal(planOutput({ existing: HAND_GUIDE, source: 'narrative' }), 'handwritten');
  assert.equal(planOutput({ existing: null, source: null }), 'no-source');
  assert.equal(planOutput({ existing: LEGACY_GUIDE, source: null }), 'no-source');
  assert.equal(planOutput({ existing: null, source: 'narrative' }), 'write');
  assert.equal(planOutput({ existing: LEGACY_GUIDE, source: 'narrative' }), 'write');
});

test('isUnchanged ignores the generated timestamp and line endings only', () => {
  const later = LEGACY_GUIDE.replace('2026-06-24T21:06:05.284Z', '2026-11-27T00:00:00.000Z');
  assert.equal(isUnchanged(LEGACY_GUIDE, later), true);
  assert.equal(isUnchanged(LEGACY_GUIDE.replace(/\n/g, '\r\n'), later), true);
  assert.equal(isUnchanged(LEGACY_GUIDE, `${later}more\n`), false);
  assert.equal(isUnchanged(null, later), false);
});

function writeApp(appsDir, app, files) {
  const dir = join(appsDir, app);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({ app })}\n`);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function runCompose(root) {
  return execFileSync(process.execPath, [COMPOSE, `--root=${root}`], { encoding: 'utf8' });
}

test('compose run: hand-written files untouched, no stubs invented, rerun is a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'bbb-compose-'));
  try {
    const appsDir = join(root, 'docs', 'apps');
    // Hand-written guide, no _narrative.md: the #398 case (basis, bastion).
    const hand = writeApp(appsDir, 'hand', { 'guide.md': HAND_GUIDE });
    // Hand-written guide AND a _narrative.md: still hand-written (bay, blip).
    const handNarr = writeApp(appsDir, 'handnarr', {
      'guide.md': HAND_GUIDE,
      '_narrative.md': 'Narr.\n',
    });
    // No sources at all (bin): nothing may be created.
    const bare = writeApp(appsDir, 'bare', {});
    // A compose-owned app with sources.
    const gen = writeApp(appsDir, 'gen', {
      'guide.md': LEGACY_GUIDE,
      '_narrative.md': 'Gen narrative.\n',
      '_marketing_hook.md': 'Gen hook.\n',
      'mcp-tools.md': '| `gen_tool` | x |\n',
    });

    const out = runCompose(root);
    assert.match(out, /hand\/guide\.md/);

    assert.equal(readFileSync(join(hand, 'guide.md'), 'utf8'), HAND_GUIDE);
    assert.equal(readFileSync(join(handNarr, 'guide.md'), 'utf8'), HAND_GUIDE);
    assert.deepEqual(readdirSync(hand).sort(), ['guide.md', 'meta.json']);
    assert.deepEqual(readdirSync(bare).sort(), ['meta.json']);
    assert.equal(
      existsSync(join(handNarr, 'marketing.md')),
      false,
      'no marketing.md without a hook',
    );

    const guide = readFileSync(join(gen, 'guide.md'), 'utf8');
    const marketing = readFileSync(join(gen, 'marketing.md'), 'utf8');
    assert.ok(guide.includes(GENERATED_MARKER) && guide.includes('Gen narrative.'));
    assert.ok(marketing.includes(GENERATED_MARKER) && marketing.includes('Gen hook.'));

    // Second run on unchanged sources: byte-identical (no timestamp churn).
    const rerun = runCompose(root);
    assert.match(rerun, /Written: {3}0 /);
    assert.equal(readFileSync(join(gen, 'guide.md'), 'utf8'), guide);
    assert.equal(readFileSync(join(gen, 'marketing.md'), 'utf8'), marketing);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every committed guide.md without a generated marker is one compose skips', () => {
  const appsDir = join(ROOT, 'docs', 'apps');
  for (const app of readdirSync(appsDir)) {
    const guidePath = join(appsDir, app, 'guide.md');
    if (!existsSync(guidePath)) continue;
    const guide = readFileSync(guidePath, 'utf8');
    if (isGenerated(guide)) {
      assert.ok(
        existsSync(join(appsDir, app, '_narrative.md')),
        `docs/apps/${app}/guide.md is marked generated but has no _narrative.md to regenerate it from`,
      );
    } else {
      assert.equal(planOutput({ existing: guide, source: 'x' }), 'handwritten', app);
    }
  }
});
