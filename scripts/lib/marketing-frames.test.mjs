// node --test scripts/lib/marketing-frames.test.mjs
//
// #418: a marketing section's screenshot frames each show a distinct product surface (a dark copy
// of a frame already shown is the same surface), every frame src exists under site/public, and
// the light-to-dark hover only ever points at a dark capture that exists. The hover twin is
// gated by a build-time list of dark captures read from disk (site/vite.config.ts), consumed by
// darkTwinOf in site/src/components/ui/screenshot-frame.tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const SECTIONS = join(SITE, 'src', 'components', 'sections');

/** Every /screenshots/... literal a section file references (JSX src, object src/screenshot). */
export function screenshotRefs(source) {
  return [...source.matchAll(/["'`](\/screenshots\/[^"'`\s]+\.(?:png|jpe?g|webp|gif))["'`]/g)].map((m) => m[1]);
}

/** Light and dark captures of one view are the same surface. */
export const surfaceOf = (src) => src.replace(/\/(light|dark)\//, '/');

function sections() {
  return readdirSync(SECTIONS)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, refs: screenshotRefs(readFileSync(join(SECTIONS, f), 'utf8')) }))
    .filter(({ refs }) => refs.length > 0);
}

const exists = (urlPath) => existsSync(join(SITE, 'public', ...urlPath.split('/').filter(Boolean)));

test('the parsers see the sections and treat light/dark of one view as one surface', () => {
  assert.ok(sections().length >= 20);
  assert.deepEqual(screenshotRefs(`src="/screenshots/a/light/1.png" x={'/screenshots/a/dark/1.png'}`), ['/screenshots/a/light/1.png', '/screenshots/a/dark/1.png']);
  assert.equal(surfaceOf('/screenshots/a/dark/1.png'), surfaceOf('/screenshots/a/light/1.png'));
});

test('every frame src in every marketing section exists under site/public', () => {
  const missing = sections().flatMap(({ file, refs }) => refs.filter((r) => !exists(r)).map((r) => `${file}: ${r}`));
  assert.deepEqual(missing, []);
});

test('every hover twin a frame can show exists', () => {
  const frame = readFileSync(join(SITE, 'src', 'components', 'ui', 'screenshot-frame.tsx'), 'utf8');
  const vite = readFileSync(join(SITE, 'vite.config.ts'), 'utf8');
  // The twin is only used when the build-time list of on-disk dark captures contains it.
  assert.match(vite, /__DARK_CAPTURES__:\s*JSON\.stringify\(darkCaptures\(\)\)/);
  assert.match(frame, /DARK_CAPTURES\.has\(darkSrc\)/);
  assert.match(frame, /const darkSrc = darkTwinOf\(src\) \?\? src;/);
  assert.doesNotMatch(frame, /onError=\{\(\) => setDarkOk/, 'a hover must not rely on a 404 to fall back');
  // The Bastion section's frames, the ones the close-out audit found, all resolve.
  const bastion = sections().find((s) => s.file === 'bastion-section.tsx');
  for (const r of bastion.refs) assert.ok(exists(r), r);
});

test('each section shows distinct surfaces', () => {
  const dups = [];
  for (const { file, refs } of sections()) {
    const seen = new Set();
    for (const r of refs) {
      if (seen.has(surfaceOf(r))) dups.push(`${file}: ${r}`);
      seen.add(surfaceOf(r));
    }
  }
  assert.deepEqual(dups, []);
});
