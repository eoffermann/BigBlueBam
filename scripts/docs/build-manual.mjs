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
 *   Order: introduction FIRST, then bam, then the remaining apps alphabetically.
 *   title is taken from help-index.json.title, falling back to the markdown H1.
 *
 * Run: node scripts/docs/build-manual.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLaunchpadCatalog, docDirForAppId } from './lib/tool-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(ROOT, 'docs', 'apps');
const OUT_FILE = path.join(ROOT, 'site', 'src', 'content', 'manual.generated.json');
const OUT_DIMS = path.join(ROOT, 'site', 'src', 'content', 'manual-image-dims.generated.json');
const PUBLIC_DIR = path.join(ROOT, 'site', 'public');

/** Read a PNG's intrinsic width/height from its header (IHDR at bytes 16-24). */
function pngSize(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null; // not a PNG
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// The suite introduction plus every documented app. introduction is pinned
// first, then bam, then the rest alphabetically (see orderRank below). The app
// roster is derived from LAUNCHPAD_CATALOG so a new app flows in automatically;
// an app that has no help.md yet degrades to a short text-only stub entry
// rather than failing the build.
const LAUNCHPAD = readLaunchpadCatalog();
const LAUNCHPAD_BY_DIR = new Map(
  LAUNCHPAD.map((a) => [docDirForAppId(a.id), a]),
);
const APPS = ['introduction', ...LAUNCHPAD.map((a) => docDirForAppId(a.id))];

/**
 * Build a minimal text-only manual entry for an app whose help.md does not
 * exist yet, so the manual stays complete instead of dropping the app.
 */
function stubEntry(app) {
  const meta = LAUNCHPAD_BY_DIR.get(app);
  const name = meta ? meta.name : app.charAt(0).toUpperCase() + app.slice(1);
  const desc = meta ? meta.description : '';
  const markdown = [
    `# ${name}`,
    '',
    desc ? `${name} (${desc}).` : `${name}.`,
    '',
    'A full guide for this app is coming soon. In the meantime, explore it in the app itself and use the in-app Help Center.',
    '',
  ].join('\n');
  return { app, title: name, toc: [], markdown };
}

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
      problems.push(`${app}: missing help.md (using text-only stub entry)`);
      entries.push(stubEntry(app));
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

  // Order: introduction first, then bam, then alphabetical by app slug.
  const orderRank = (app) => (app === 'introduction' ? 0 : app === 'bam' ? 1 : 2);
  entries.sort((a, b) => {
    const ra = orderRank(a.app);
    const rb = orderRank(b.app);
    if (ra !== rb) return ra - rb;
    return a.app.localeCompare(b.app);
  });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  // Intrinsic dimensions for every embedded screenshot. The client reserves
  // space via aspect-ratio so lazy-loading images don't shift layout — which
  // is what made anchor-scrolling land short of the target section.
  const imageDims = {};
  let dimsMissing = 0;
  for (const e of entries) {
    const re = /\]\((\/screenshots\/[^)]+\.png)\)/g;
    let m;
    while ((m = re.exec(e.markdown)) !== null) {
      const src = m[1];
      if (imageDims[src]) continue;
      const dim = pngSize(path.join(PUBLIC_DIR, src));
      if (dim) imageDims[src] = [dim.w, dim.h];
      else dimsMissing++;
    }
  }
  fs.writeFileSync(OUT_DIMS, JSON.stringify(imageDims, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUT_DIMS)} with ${Object.keys(imageDims).length} image dimensions${dimsMissing ? ` (${dimsMissing} unreadable)` : ''}.`);

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
