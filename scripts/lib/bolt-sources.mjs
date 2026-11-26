// Reads the canonical Bolt source list (BOLT_SOURCES) straight from
// packages/shared/src/bolt-sources.ts, so the CI guards need no build step.
// Used by scripts/check-bolt-catalog.mjs and scripts/check-bolt-enum.mjs (issue #124).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const BOLT_SOURCES_FILE = join(REPO_ROOT, 'packages', 'shared', 'src', 'bolt-sources.ts');

/** Parse the `BOLT_SOURCES = [ ... ] as const` literal out of TypeScript source text. */
export function parseBoltSources(text) {
  const m = /export const BOLT_SOURCES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(text);
  if (!m) throw new Error('could not find `export const BOLT_SOURCES = [...] as const`');
  const values = [];
  const re = /['"]([a-z][a-z0-9_]*)['"]/g;
  let v;
  while ((v = re.exec(m[1])) !== null) values.push(v[1]);
  if (values.length === 0) throw new Error('BOLT_SOURCES parsed as empty');
  const dupes = values.filter((x, i) => values.indexOf(x) !== i);
  if (dupes.length) throw new Error(`BOLT_SOURCES has duplicates: ${dupes.join(', ')}`);
  return values;
}

export function loadBoltSources(file = BOLT_SOURCES_FILE) {
  return parseBoltSources(readFileSync(file, 'utf8'));
}

/** Compare two source lists as sets. Returns { missingInDb, extraInDb }. */
export function compareSourceSets(expected, actual) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missingInDb: expected.filter((x) => !a.has(x)),
    extraInDb: actual.filter((x) => !e.has(x)),
  };
}
