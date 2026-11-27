// Regression test for #366: the help-index builder stripped every `#` and `>`
// (and `_`) from a line, including inside inline code, so the Bay guest-link
// URL `/bay/r#<token>` reached the search index as "/bay/r<token".

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripMd } from './help-strip-md.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('inline code keeps #, > and _ verbatim', () => {
  assert.equal(
    stripMd('Share a public URL at `/bay/r#<token>` with the client.'),
    'Share a public URL at /bay/r#<token> with the client.',
  );
  assert.equal(stripMd('Patterns like `bond_get_*` and `a -> b`.'), 'Patterns like bond_get_* and a -> b.');
});

test('prose keeps a mid-line # and > as content', () => {
  assert.equal(stripMd('The secret sits after the # in the URL.'), 'The secret sits after the # in the URL.');
  assert.equal(stripMd('Settings -> Agents'), 'Settings -> Agents');
});

test('structural markers and emphasis are still removed', () => {
  assert.equal(stripMd('> **Note:** read _this_ first'), 'Note: read this first');
  assert.equal(stripMd('## Heading with `code`'), 'Heading with code');
  assert.equal(stripMd('See [the guide](./guide.md) ![img](x.png)'), 'See the guide');
  assert.equal(stripMd('snake_case stays'), 'snake_case stays');
});

test('the committed Bay help index carries the guest-link URL intact', () => {
  const idx = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'apps', 'bay', 'help-index.json'), 'utf8'));
  const all = idx.sections.map((s) => s.text).join('\n');
  assert.ok(all.includes('/bay/r#'), 'expected /bay/r# in the Bay help index search text');
  assert.ok(!all.includes('/bay/r<token'), 'Bay help index still has the mangled /bay/r<token');
});

test('build-help-index.mjs uses the shared stripMd (no second copy)', () => {
  const src = readFileSync(path.join(ROOT, 'scripts', 'help', 'build-help-index.mjs'), 'utf8');
  assert.match(src, /from '\.\.\/lib\/help-strip-md\.mjs'/);
  assert.doesNotMatch(src, /function stripMd\(/);
});
