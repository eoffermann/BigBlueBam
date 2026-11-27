// #396: every file under site/src/content must be read by the site. The docs
// publish stage used to copy docs/apps/<app>/marketing.md to
// site/src/content/apps/<app>.md, but nothing in site/ imported those copies. They
// drifted from their sources in both directions, and builders stopped running the
// publish stage end to end to avoid overwriting them. Dead generated output that
// agents work around is worse than none, so a content file that no site source
// imports fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SITE = join(ROOT, 'site');
const CONTENT = join(SITE, 'src', 'content');

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

test('every file under site/src/content is imported by site source', () => {
  const contentFiles = walk(CONTENT, () => true);
  assert.ok(contentFiles.length > 0, 'site/src/content has no files; the walk is broken');

  const sources = [
    ...walk(join(SITE, 'src'), (n) => /\.(tsx?|jsx?|mjs)$/.test(n)),
    ...walk(SITE, (n) => /^vite\.config\.(t|j|mj)s$/.test(n)).filter((f) => !f.includes(`${sep}src${sep}`)),
  ].map((f) => readFileSync(f, 'utf8'));

  const unread = contentFiles
    .map((f) => relative(CONTENT, f).split(sep).join('/'))
    .filter((rel) => !sources.some((src) => src.includes(`content/${rel}`)));

  assert.deepEqual(
    unread,
    [],
    `site/src/content file(s) nothing in site/ imports: ${unread.join(', ')}. Delete them (and whatever writes them) or import them where they are meant to render.`,
  );
});
