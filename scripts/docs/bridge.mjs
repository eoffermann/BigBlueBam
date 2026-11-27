#!/usr/bin/env node

/**
 * Bridge: new capture engine -> docs layout.
 *
 * The recipe-driven engine (packages/docs-capture) writes a flat shared tree
 * `screenshots/<app>/<id>.png` + `screenshots/manifest.json`. The docs/help/
 * marketing pipeline instead expects `docs/apps/<app>/screenshots/<light|dark>/
 * <NN>-<slug>.png`. This script maps the former into the latter for every
 * capture that opted into the docs via its recipe `doc:` field (surfaced on the
 * manifest entry as `doc: { order, label }`).
 *
 * For each doc-marked entry it copies the PNG to
 *   docs/apps/<app>/screenshots/<theme>/<NN>-<slug>.png
 * where NN = zero-padded `doc.order` and slug = the recipe id with the `<app>-`
 * prefix and any trailing `-dark` removed (so a light recipe and its `-dark`
 * sibling share an ordinal and land in light/ and dark/).
 *
 * It does NOT write `docs/apps/<app>/meta.json`. That file is owned by
 * scripts/docs/extract.mjs (an object: route_files, schema_modules, src_hash,
 * mcp_tool_count, ...) and read by publish.mjs for the README card. The bridge
 * used to overwrite it with an array of shots, which no consumer reads, and
 * the README card then printed "undefined routes, undefined schemas". The
 * per-shot record (sha256, size, capture time) lives in screenshots/manifest.json.
 *
 * Captures without a `doc:` field are ignored here; they stay in the shared
 * `screenshots/` tree for ad-hoc / marketing use.
 *
 * Usage:
 *   node scripts/docs/bridge.mjs                  # every app present in the manifest
 *   node scripts/docs/bridge.mjs --apps=bam,bond  # subset
 *   node scripts/docs/bridge.mjs --dry-run        # report only, no writes
 *   node scripts/docs/bridge.mjs --root=<dir>     # another repo-shaped tree (tests)
 *
 * One file, one writer (#400): see scripts/docs/lib/app-doc-files.mjs for who
 * owns each generated file under docs/apps/<app>/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootFlag = args.find((a) => a.startsWith('--root='));
const ROOT = rootFlag ? path.resolve(rootFlag.slice('--root='.length)) : path.resolve(__dirname, '..', '..');
const SHOTS_ROOT = path.join(ROOT, 'screenshots');
const MANIFEST = path.join(SHOTS_ROOT, 'manifest.json');

const dryRun = args.includes('--dry-run');
const appsFlag = args.find((a) => a.startsWith('--apps='));
const appFilter = appsFlag
  ? new Set(
      appsFlag
        .slice('--apps='.length)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    )
  : null;

const pad2 = (n) => String(n).padStart(2, '0');

/** recipe id "bam-board-dark" + app "bam" -> "board" */
function slugFor(id, app) {
  let s = id.startsWith(`${app}-`) ? id.slice(app.length + 1) : id;
  s = s.replace(/-dark$/, '');
  return s;
}

/** Remove the *.png currently in an app's light/ + dark/ dirs (the bridged set
 *  is regenerated from the manifest, so stale renamed slugs must not linger). */
function clearThemeDirs(app) {
  for (const theme of ['light', 'dark']) {
    const dir = path.join(ROOT, 'docs', 'apps', app, 'screenshots', theme);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.png')) fs.rmSync(path.join(dir, f));
    }
  }
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`Manifest not found: ${MANIFEST}\nRun the capture engine first (pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts).`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const docEntries = manifest.filter((e) => e.doc && (!appFilter || appFilter.has(e.app)));

  if (docEntries.length === 0) {
    console.log('No doc-marked captures in the manifest (recipes need a `doc:` field). Nothing to bridge.');
    return;
  }

  const byApp = new Map();
  for (const e of docEntries) {
    if (!byApp.has(e.app)) byApp.set(e.app, []);
    byApp.get(e.app).push(e);
  }

  let copied = 0;
  let missing = 0;
  const summary = [];

  for (const [app, entries] of [...byApp.entries()].sort()) {
    if (!dryRun) clearThemeDirs(app);
    entries.sort((a, b) => a.doc.order - b.doc.order || a.theme.localeCompare(b.theme));

    let bridged = 0;
    for (const e of entries) {
      const slug = slugFor(e.id, app);
      const fname = `${pad2(e.doc.order)}-${slug}.png`;
      const src = path.join(SHOTS_ROOT, ...e.file.split('/'));
      const destDir = path.join(ROOT, 'docs', 'apps', app, 'screenshots', e.theme);
      const dest = path.join(destDir, fname);

      if (!fs.existsSync(src)) {
        console.warn(`  [skip] ${app}/${e.id}: source image missing (${e.file})`);
        missing++;
        continue;
      }
      if (!dryRun) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
      }
      copied++;
      bridged++;
    }

    summary.push(`${app}: ${bridged} image(s)`);
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Bridged ${copied} doc image(s)${missing ? ` (${missing} source(s) missing)` : ''} across ${summary.length} app(s):`);
  for (const s of summary) console.log(`  - ${s}`);
}

main();
