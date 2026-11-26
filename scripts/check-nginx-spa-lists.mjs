#!/usr/bin/env node
/**
 * nginx SPA-list drift guard (issue #127).
 *
 * The set of SPAs an nginx config serves is one fact; the configs also repeat it in
 * two regex locations (the index.html no-cache rule and the hashed-assets cache rule).
 * basis, braid, bulwark, burn and bursar were once missing from the index.html rule,
 * so browsers kept a stale shell after deploys.
 *
 * For each config this derives the served SPAs from the `try_files ... /<spa>/index.html`
 * fallbacks (the place that actually serves them) and fails when either regex list is
 * missing an SPA or names one the config does not serve. It also fails when an app in
 * LAUNCHPAD_CATALOG (apps/api/src/routes/system-settings.routes.ts) with a local
 * `/<id>/` path is not served by nginx-with-site.conf.
 *
 * Exit codes: 0 clean, 1 drift, 2 parse error.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './lib/bolt-sources.mjs';

const CONFIGS = [
  'infra/nginx/nginx-with-site.conf',
  'infra/nginx/nginx.conf',
  'infra/nginx/nginx.railway.conf',
];
const LAUNCHPAD_FILE = 'apps/api/src/routes/system-settings.routes.ts';

const INDEX_RE = /location\s+~\*?\s+\^\/\(([a-z0-9|]+)\)\/index\\\.html\$/;
const ASSETS_RE = /location\s+~\*?\s+\^\/\(([a-z0-9|]+)\)\/assets\//;

export function servedSpas(text) {
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /try_files\s+\$uri\s+\$uri\/\s+\/([a-z0-9-]+)\/index\.html\s*;/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

function regexList(text, re) {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = re.exec(line);
    if (m) return m[1].split('|');
  }
  return null;
}

export function checkConfig(name, text) {
  const problems = [];
  const served = servedSpas(text);
  if (served.size === 0) {
    problems.push(`${name}: found no \`try_files $uri $uri/ /<spa>/index.html;\` fallbacks (parser out of date?)`);
    return { problems, served };
  }
  for (const [label, re] of [
    ['index.html no-cache', INDEX_RE],
    ['assets cache', ASSETS_RE],
  ]) {
    const list = regexList(text, re);
    if (!list) {
      problems.push(`${name}: no ${label} location regex found`);
      continue;
    }
    const listed = new Set(list);
    const missing = [...served].filter((s) => !listed.has(s));
    const extra = list.filter((s) => !served.has(s));
    if (missing.length) problems.push(`${name}: ${label} regex is missing served SPA(s): ${missing.join(', ')}`);
    if (extra.length) problems.push(`${name}: ${label} regex names SPA(s) this config does not serve: ${extra.join(', ')}`);
  }
  return { problems, served };
}

export function launchpadPaths(text) {
  const ids = [];
  const re = /path:\s*'\/([a-z0-9-]+)\/'/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

function main() {
  const problems = [];
  let siteServed = null;
  for (const rel of CONFIGS) {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const res = checkConfig(rel, text);
    problems.push(...res.problems);
    if (rel.endsWith('nginx-with-site.conf')) siteServed = res.served;
    console.log(`[nginx-spa] ${rel}: ${res.served.size} SPAs served`);
  }
  const launchpad = launchpadPaths(readFileSync(join(REPO_ROOT, LAUNCHPAD_FILE), 'utf8'));
  if (launchpad.length === 0) {
    console.error(`[nginx-spa] parsed no paths from ${LAUNCHPAD_FILE}`);
    process.exit(2);
  }
  const notServed = launchpad.filter((id) => !siteServed.has(id));
  if (notServed.length) {
    problems.push(
      `infra/nginx/nginx-with-site.conf does not serve Launchpad app(s): ${notServed.join(', ')} (add the SPA location)`,
    );
  }
  if (problems.length === 0) {
    console.log(`[nginx-spa] OK: every SPA list matches the served SPAs (${launchpad.length} Launchpad apps)`);
    process.exit(0);
  }
  for (const p of problems) console.error(`[nginx-spa] ${p}`);
  console.error('[nginx-spa] Fix the source configs, then run: node scripts/gen-railway-configs.mjs');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
