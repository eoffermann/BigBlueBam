#!/usr/bin/env node

/**
 * Help-index generator (suite-help-system).
 *
 * Reads each docs/apps/<app>/help.md and writes docs/apps/<app>/help-index.json:
 *   { app, title, toc, sections, labels, crossrefs }
 *
 * The index is DERIVED. Never hand-edit help-index.json; edit help.md and re-run.
 *
 * Usage:
 *   node scripts/help/build-help-index.mjs                  # all apps with a help.md
 *   node scripts/help/build-help-index.mjs --apps bam,blast # specific apps
 *   node scripts/help/build-help-index.mjs --check          # fail (exit 1) if any index is stale
 *
 * IMPORTANT: slugify() here MUST match the heading-id function the Help Center
 * component uses to render anchors, or deep-links will not land. The shared
 * implementation lives in packages/ui/help-center.tsx (keep them identical).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(ROOT, 'docs', 'apps');

// --- args ---
const args = process.argv.slice(2);
let only = null;
let checkMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apps' && args[i + 1]) {
    only = args[i + 1].split(',').map((s) => s.trim().toLowerCase());
    i++;
  } else if (args[i] === '--check') {
    checkMode = true;
  }
}

/** GitHub-style heading slug. MUST match the Help Center renderer. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** Strip inline markdown to plain text for the search index. */
function stripMd(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Bold-span content we should NOT treat as a UI label (story/structure words).
const LABEL_DENYLIST = new Set([
  'who', 'goal', 'before you start', 'steps', 'result', 'related', 'note', 'tip',
  'who:', 'goal:', 'result:', 'related:',
]);

/** Extract candidate UI labels from a line: bold spans, quotes stripped. */
function extractLabels(line) {
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    let label = m[1].trim().replace(/^["']|["']$/g, '').replace(/["']$/, '').trim();
    label = label.replace(/^"|"$/g, '').trim();
    if (!label) continue;
    const norm = label.toLowerCase().replace(/:$/, '');
    if (LABEL_DENYLIST.has(norm)) continue;
    if (label.length < 2 || label.length > 60) continue; // not single keys or sentences
    if (!/[a-zA-Z0-9]/.test(label)) continue; // pure punctuation (e.g. a / or , shortcut key)
    if (label.includes(',') || /[.]$/.test(label)) continue; // sentence fragment, not a control label
    out.push(label);
  }
  return out;
}

function buildIndex(app, md, appKeys, appTitles) {
  const lines = md.split('\n');
  const toc = [];
  const sections = [];
  const labels = {};
  const collisions = [];
  const crossrefs = [];

  let title = app;
  let curAnchor = null;
  let curSection = null;
  let inRelated = false;
  let inFence = false;

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) { inFence = !inFence; if (curSection) curSection.text.push(stripMd(line)); continue; }
    if (inFence) { if (curSection) curSection.text.push(line); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const headingText = stripMd(h[2]);
      if (level === 1 && title === app) title = headingText.split(' - ')[0].trim();
      const anchor = slugify(headingText);
      inRelated = /^related$/i.test(headingText);
      if (level >= 2) {
        toc.push({ anchor, title: headingText, level });
        curAnchor = anchor;
        curSection = { anchor, title: headingText, text: [] };
        sections.push(curSection);
      }
      continue;
    }

    // crossrefs from the Related section: other apps named in bold (**Banter**),
    // referenced by SPA path (/banter/), or by doc path (docs/apps/banter/).
    if (inRelated) {
      const candidates = [];
      let bm;
      const boldRe = /\*\*([^*]+)\*\*/g;
      while ((bm = boldRe.exec(line)) !== null) candidates.push(slugify(bm[1]));
      let pm;
      const pathRe = /[/(]([a-z0-9-]+)\//g;
      while ((pm = pathRe.exec(line)) !== null) candidates.push(pm[1]);
      for (const c of candidates) {
        if (appKeys.has(c) && c !== app && !crossrefs.find((x) => x.app === c)) {
          crossrefs.push({ app: c, title: appTitles[c] || c });
        }
      }
    }

    if (curSection) curSection.text.push(stripMd(line));

    // labels -> nearest enclosing section anchor
    if (curAnchor) {
      for (const label of extractLabels(line)) {
        if (labels[label] === undefined) {
          labels[label] = curAnchor;
        } else if (labels[label] !== curAnchor && !collisions.find((c) => c.label === label)) {
          collisions.push({ label, kept: labels[label], also: curAnchor });
        }
      }
    }
  }

  const sectionsOut = sections.map((s) => ({
    anchor: s.anchor,
    title: s.title,
    text: s.text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000),
  }));

  // stable key order
  const sortedLabels = {};
  for (const k of Object.keys(labels).sort()) sortedLabels[k] = labels[k];

  return {
    index: { app, title, toc, sections: sectionsOut, labels: sortedLabels, crossrefs },
    collisions,
  };
}

// --- run ---
const allApps = fs
  .readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(APPS_DIR, d.name, 'help.md')))
  .map((d) => d.name)
  .sort();
const appKeys = new Set(allApps);
const appTitles = {};
for (const a of allApps) {
  const h1 = fs.readFileSync(path.join(APPS_DIR, a, 'help.md'), 'utf8').match(/^#\s+(.*)$/m);
  appTitles[a] = h1 ? stripMd(h1[1]).split(' - ')[0].trim() : a;
}
const appDirs = allApps.filter((a) => !only || only.includes(a));

let stale = 0;
let total = 0;
const summary = [];

for (const app of appDirs) {
  const md = fs.readFileSync(path.join(APPS_DIR, app, 'help.md'), 'utf8');
  const { index, collisions } = buildIndex(app, md, appKeys, appTitles);
  const json = JSON.stringify(index, null, 2) + '\n';
  const outPath = path.join(APPS_DIR, app, 'help-index.json');
  const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  const changed = prev !== json;

  if (checkMode) {
    if (changed) { stale++; console.error(`[stale] ${app}/help-index.json out of date`); }
  } else {
    fs.writeFileSync(outPath, json);
  }
  total++;
  summary.push({ app, toc: index.toc.length, sections: index.sections.length, labels: Object.keys(index.labels).length, crossrefs: index.crossrefs.length, collisions: collisions.length, changed });
}

console.log('\n=== help-index ' + (checkMode ? 'check' : 'build') + ' ===');
for (const s of summary) {
  console.log(`  ${s.app.padEnd(10)} toc:${String(s.toc).padStart(2)}  sections:${String(s.sections).padStart(2)}  labels:${String(s.labels).padStart(3)}  xref:${s.crossrefs}  ${s.collisions ? 'collisions:' + s.collisions : ''}${checkMode && s.changed ? '  STALE' : ''}`);
}
console.log(`apps: ${total}`);

if (checkMode && stale > 0) {
  console.error(`\n${stale} index file(s) stale. Run: node scripts/help/build-help-index.mjs`);
  process.exit(1);
}
console.log(checkMode ? 'All indexes current.' : 'Indexes written.');
