// Refs #324: Brief's word counter did `div.innerHTML = editorHtml` on an element created in
// the live document. Handlers like <img onerror> fire on such detached elements, so any
// HTML that reaches that line is a script sink. HTML-to-text goes through DOMParser (an
// inert document) and rendering goes through the DOMPurify-sanitized React path. This
// scans every app/package/site source file so no SPA reintroduces a raw innerHTML write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', 'test', 'tests', '__tests__']);

function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name)) yield p;
  }
}

function srcRoots() {
  const roots = [join(ROOT, 'site', 'src')];
  for (const top of ['apps', 'packages']) {
    for (const name of readdirSync(join(ROOT, top))) roots.push(join(ROOT, top, name, 'src'));
  }
  return roots;
}

test('no source file assigns to .innerHTML / .outerHTML or calls insertAdjacentHTML', () => {
  const hits = [];
  const sink = /\.(innerHTML|outerHTML)\s*(\+?=)(?!=)|\.insertAdjacentHTML\s*\(/;
  for (const root of srcRoots()) {
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (sink.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(hits, [], `raw HTML sinks found (use DOMParser for text, DOMPurify for render):\n${hits.join('\n')}`);
});
