#!/usr/bin/env node
/**
 * The one path from docs screenshots to the marketing site (#380).
 *
 * docs/apps/<app>/screenshots/<theme>/<file>.png is the source of truth. The
 * site (manual + app sections) serves them from
 * site/public/screenshots/<app>/<theme>/<file>.png with IDENTICAL names. Never
 * hand-copy or rename a screenshot into site/public; run this instead (it is
 * also run by `pnpm docs:manual` and by scripts/docs/publish.mjs).
 *
 * Usage:
 *   node scripts/docs/sync-site-screenshots.mjs            # copy new/changed files
 *   node scripts/docs/sync-site-screenshots.mjs --check    # exit 1 if any copy is missing or differs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** List [srcAbs, destAbs, relFromPublicScreenshots] for every docs screenshot. */
export function listScreenshotPairs(root = ROOT) {
  const appsDir = path.join(root, 'docs', 'apps');
  const destRoot = path.join(root, 'site', 'public', 'screenshots');
  const pairs = [];
  const walk = (src, dest, rel) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dest, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(s, d, r);
      else if (/\.(png|jpe?g|webp|gif)$/i.test(e.name)) pairs.push([s, d, r]);
    }
  };
  for (const app of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const src = path.join(appsDir, app.name, 'screenshots');
    if (fs.existsSync(src)) walk(src, path.join(destRoot, app.name), app.name);
  }
  return pairs;
}

function sameBytes(a, b) {
  if (!fs.existsSync(b)) return false;
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Copy every docs screenshot into site/public. Returns the relative paths copied. */
export function syncSiteScreenshots(root = ROOT) {
  const copied = [];
  for (const [src, dest, rel] of listScreenshotPairs(root)) {
    if (sameBytes(src, dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(rel);
  }
  return copied;
}

/** Relative paths whose site copy is missing or differs from the docs source. */
export function staleSiteScreenshots(root = ROOT) {
  return listScreenshotPairs(root)
    .filter(([src, dest]) => !sameBytes(src, dest))
    .map(([, , rel]) => rel);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes('--check')) {
    const stale = staleSiteScreenshots();
    if (stale.length) {
      console.error(`[stale] ${stale.length} site screenshot copy(ies) missing or out of date:`);
      for (const r of stale) console.error(`  - site/public/screenshots/${r}`);
      console.error('Run: node scripts/docs/sync-site-screenshots.mjs');
      process.exit(1);
    }
    console.log('Site screenshot copies are current.');
  } else {
    console.log('Syncing docs/apps/*/screenshots into site/public/screenshots ...');
    const copied = syncSiteScreenshots();
    for (const r of copied) console.log(`  copied ${r}`);
    console.log(`${copied.length} file(s) copied.`);
  }
}
