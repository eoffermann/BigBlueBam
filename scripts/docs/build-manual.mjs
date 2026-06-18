#!/usr/bin/env node
/**
 * build-manual.mjs
 *
 * Aggregates every app's help documentation into a single JSON manifest that the
 * marketing site renders as the unified "BigBlueBam Manual" at /docs.
 *
 * For each of the 16 apps it reads:
 *   - docs/apps/<app>/help.md         (the manual prose + image embeds)
 *   - docs/apps/<app>/help-index.json (title + derived TOC for navigation)
 *
 * It rewrites each help.md's RELATIVE screenshot embeds so they resolve against
 * the site's public dir:
 *   ![alt](screenshots/light/NN-slug.png)    -> ![alt](/screenshots/<app>/light/NN-slug.png)
 *   ![alt](./screenshots/light/NN-slug.png)  -> ![alt](/screenshots/<app>/light/NN-slug.png)
 *
 * Output: site/src/content/manual.generated.json
 *   An ordered array of { app, title, toc, markdown }.
 *   Order: bam FIRST, then the remaining apps alphabetically.
 *   title is taken from help-index.json.title, falling back to the markdown H1.
 *
 * Run: node scripts/docs/build-manual.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(ROOT, 'docs', 'apps');
const OUT_FILE = path.join(ROOT, 'site', 'src', 'content', 'manual.generated.json');

// The 16 documented apps. bam is pinned first; the rest follow alphabetically.
const APPS = [
  'bam',
  'banter',
  'beacon',
  'bearing',
  'bench',
  'bill',
  'blank',
  'blast',
  'blueprint',
  'board',
  'bolt',
  'bond',
  'book',
  'brief',
  'bureau',
  'helpdesk',
];

/**
 * Rewrite relative screenshot embeds to absolute, app-scoped public paths.
 * Handles both `](screenshots/...)` and `](./screenshots/...)` forms.
 * Absolute paths (already starting with `/screenshots/` or `http`) are left alone.
 */
function rewriteImagePaths(markdown, app) {
  return markdown.replace(
    /\]\(\.?\/?screenshots\//g,
    `](/screenshots/${app}/`,
  );
}

/** Extract the first markdown H1 as a title fallback. */
function firstH1(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  if (!m) return null;
  // "Bam - Sprint-based Kanban..." -> "Bam"
  return m[1].split(' - ')[0].trim();
}

function build() {
  const entries = [];
  const problems = [];

  for (const app of APPS) {
    const helpPath = path.join(APPS_DIR, app, 'help.md');
    const indexPath = path.join(APPS_DIR, app, 'help-index.json');

    if (!fs.existsSync(helpPath)) {
      problems.push(`${app}: missing help.md`);
      continue;
    }

    const rawMarkdown = fs.readFileSync(helpPath, 'utf8');
    const markdown = rewriteImagePaths(rawMarkdown, app);

    let title = null;
    let toc = [];
    if (fs.existsSync(indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        title = idx.title || null;
        toc = Array.isArray(idx.toc) ? idx.toc : [];
      } catch (err) {
        problems.push(`${app}: help-index.json is not valid JSON (${err.message})`);
      }
    } else {
      problems.push(`${app}: missing help-index.json (TOC will be empty)`);
    }

    if (!title) title = firstH1(markdown) || app;

    entries.push({ app, title, toc, markdown });
  }

  // Order: bam first, then alphabetical by app slug.
  entries.sort((a, b) => {
    if (a.app === 'bam') return -1;
    if (b.app === 'bam') return 1;
    return a.app.localeCompare(b.app);
  });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  // --- report ---
  // A genuinely-relative leftover is `](screenshots/` or `](./screenshots/`,
  // i.e. NOT preceded by an absolute leading slash. (The negative-form match
  // below deliberately excludes the rewritten `](/screenshots/` paths.)
  const relativeImageLeftovers = entries.reduce((acc, e) => {
    const matches = e.markdown.match(/\]\((?:\.\/)?screenshots\//g);
    return acc + (matches ? matches.length : 0);
  }, 0);

  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)} with ${entries.length} entries.`);
  console.log(`  Apps: ${entries.map((e) => e.app).join(', ')}`);
  if (relativeImageLeftovers > 0) {
    console.error(`  WARNING: ${relativeImageLeftovers} relative screenshot path(s) not rewritten.`);
  } else {
    console.log('  All screenshot embeds rewritten to /screenshots/<app>/...');
  }
  if (problems.length) {
    console.warn('  Notes:');
    for (const p of problems) console.warn(`    - ${p}`);
  }

  if (entries.length !== APPS.length) {
    console.error(`  ERROR: expected ${APPS.length} entries, got ${entries.length}.`);
    process.exit(1);
  }
}

build();
