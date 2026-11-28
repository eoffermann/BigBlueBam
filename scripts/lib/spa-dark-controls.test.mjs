// node --test scripts/lib/spa-dark-controls.test.mjs
//
// Native <select> option lists are drawn by the browser from the page's color-scheme, not by
// Tailwind's dark: variant. One shared stylesheet (packages/ui/theme.css) sets color-scheme and
// dark option colors under .dark; every SPA must import it so no app ships white option popups
// with light text in dark mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMPORT = '@import "../../../../packages/ui/theme.css";';

function spaGlobals() {
  return readdirSync(join(ROOT, 'apps'))
    .map((app) => ({ app, file: join(ROOT, 'apps', app, 'src', 'styles', 'globals.css') }))
    .filter(({ file }) => existsSync(file));
}

test('the shared theme sets color-scheme and dark option colors under .dark', () => {
  const css = readFileSync(join(ROOT, 'packages', 'ui', 'theme.css'), 'utf8');
  assert.match(css, /\.dark\s*\{\s*color-scheme:\s*dark;/);
  assert.match(css, /\.dark select option[\s\S]*?background-color:\s*#[0-9a-f]{6}/i);
});

test('every SPA with a globals.css imports the shared theme right after tailwind', () => {
  const found = spaGlobals();
  assert.ok(found.length >= 20, `expected the SPA roster, found ${found.length}`);
  const missing = [];
  for (const { app, file } of found) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim());
    const at = lines.indexOf(IMPORT);
    // CSS @import must precede every other rule, so it sits in the leading @import block.
    const leadingImports = lines.slice(0, at + 1).every((l) => l === '' || l.startsWith('@import'));
    if (at < 0 || !leadingImports) missing.push(app);
  }
  assert.deepEqual(missing, [], `globals.css missing the leading theme import: ${missing.join(', ')}`);
});
