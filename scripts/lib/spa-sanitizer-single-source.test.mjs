// #331: the browser-side HTML sanitizer lives only in packages/ui/markdown.ts. 47b3f72b fixed an
// XSS by patching four of six private copies, and the sanitizer config had already split three
// ways. This guard fails when a SPA imports DOMPurify itself or defines its own sanitizeHtml.
// Server-side write-time sanitizers in *-api apps (isomorphic-dompurify) are a separate layer
// and are not covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(name)) yield full;
  }
}

function spaDirs() {
  const apps = join(ROOT, 'apps');
  return readdirSync(apps)
    .filter((name) => !name.endsWith('-api'))
    .map((name) => join(apps, name))
    .filter((dir) => existsSync(join(dir, 'vite.config.ts')) && existsSync(join(dir, 'src')));
}

test('no SPA imports DOMPurify or defines its own sanitizeHtml', () => {
  const offenders = [];
  for (const dir of spaDirs()) {
    for (const file of walk(join(dir, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file);
      if (/from\s+['"](?:isomorphic-)?dompurify['"]|require\(\s*['"](?:isomorphic-)?dompurify['"]\s*\)/.test(text)) {
        offenders.push(`${rel}: imports DOMPurify (use sanitizeHtml from @bigbluebam/ui/markdown)`);
      }
      if (/export\s+(?:async\s+)?function\s+sanitizeHtml\b/.test(text)) {
        offenders.push(`${rel}: defines sanitizeHtml (re-export it from @bigbluebam/ui/markdown)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
