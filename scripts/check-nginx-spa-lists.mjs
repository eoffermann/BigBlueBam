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
 * It also guards the internal-route deny (#226): for every proxy location it derives the
 * upstream path a client URL reaches and fails when one lands on an app's /internal/ or
 * /v1/internal/ routes without a `return 404` regex catching it first, or when a
 * browser-facing api route under /internal/ (BROWSER_FACING_INTERNAL) is denied.
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

// ─── Internal-route deny (#226) ─────────────────────────────────────────
//
// Every app's server-to-server routes live under /internal/ or /v1/internal/ on its upstream.
// For each proxy location in a config this derives what upstream path a client URL reaches and,
// when it lands on an internal route, requires a `return 404` regex location to catch it first,
// so a new app's proxy cannot ship with its internal routes open to the internet. The only
// client paths allowed through are the api's browser-facing, session-authed routes below.

/** Browser-facing api routes under /internal/ (session-authed, called by the SPAs). */
export const BROWSER_FACING_INTERNAL = [
  '/b3/api/internal/system-errors/record-browser', // packages/bureau-client SystemErrorReporter
  '/b3/api/internal/helpdesk/queue', // Bam helpdesk agent queue page
  '/b3/api/internal/helpdesk/tickets/0f1e2d3c', // Bam task helpdesk panel
  '/b3/api/internal/helpdesk/tickets/0f1e2d3c/messages',
];

/** Known server-to-server routes that must be denied (spot checks on top of the derived probes). */
const KNOWN_SERVICE_INTERNAL = [
  '/b3/api/internal/bastion/tasks/upsert',
  '/b3/api/internal/bastion/proposals/0f1e2d3c/close',
  '/b3/api/internal/helpdesk/tasks',
  '/b3/api/internal/helpdesk/tasks/0f1e2d3c/reopen',
  '/b3/api/internal/can-read',
  '/b3/api/internal/system-errors/record',
  '/b3/api/internal/llm/chat',
  '/b3/api/internal/github/deliveries/process',
  '/bastion/api/v1/internal/events',
];

/** Parses `location [mod] pattern { ... }` blocks (brace-balanced, comments stripped). */
export function parseLocations(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ''));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*location\s+(?:(=|~\*|~|\^~)\s+)?("[^"]+"|\S+)\s*\{\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const mod = m[1] ?? '';
    const pattern = m[2].replace(/^"|"$/g, '');
    let depth = 1;
    const body = [];
    let rest = m[3];
    let j = i;
    for (;;) {
      for (const ch of rest) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      body.push(rest);
      if (depth <= 0 || j + 1 >= lines.length) break;
      j++;
      rest = lines[j];
    }
    out.push({ mod, pattern, body: body.join('\n') });
  }
  return out;
}

function nginxRegex(loc) {
  return new RegExp(loc.pattern, loc.mod === '~*' ? 'i' : '');
}

/** The upstream path a client URI reaches through a prefix proxy location, or null. */
export function upstreamPath(loc, uri) {
  if (!uri.startsWith(loc.pattern)) return null;
  const rw = /rewrite\s+(\S+)\s+(\S+)\s+break\s*;/.exec(loc.body);
  if (rw) {
    const re = new RegExp(rw[1]);
    if (!re.test(uri)) return uri;
    return uri.replace(re, rw[2].replace(/\$(\d)/g, '$$$1'));
  }
  const pp = /proxy_pass\s+https?:\/\/[^/\s;]+(\/[^\s;]*)?\s*;/.exec(loc.body);
  if (!pp) return null;
  if (pp[1] === undefined) return uri;
  return pp[1] + uri.slice(loc.pattern.length);
}

/** nginx location selection, reduced to what this check needs. Returns the chosen location. */
export function selectLocation(locations, uri) {
  const exact = locations.find((l) => l.mod === '=' && l.pattern === uri);
  if (exact) return exact;
  let best = null;
  for (const l of locations) {
    if ((l.mod === '' || l.mod === '^~') && uri.startsWith(l.pattern)) {
      if (!best || l.pattern.length > best.pattern.length) best = l;
    }
  }
  if (best && best.mod === '^~') return best;
  for (const l of locations) {
    if ((l.mod === '~' || l.mod === '~*') && nginxRegex(l).test(uri)) return l;
  }
  return best;
}

// Third-party or static upstreams with no BigBlueBam /internal/ routes (LiveKit SFU, marketing site).
const NON_APP_UPSTREAMS = new Set(['livekit', 'site']);

/** The upstream service name of a proxy location (literal proxy_pass host or its `set` variable). */
export function upstreamHost(loc) {
  const literal = /proxy_pass\s+https?:\/\/([a-z0-9-]+)/i.exec(loc.body);
  if (literal) return literal[1];
  const viaSet = /set\s+\$\w+\s+"?([a-z0-9-]+)/i.exec(loc.body);
  return viaSet ? viaSet[1] : null;
}

const isDeny = (loc) => loc !== null && /^\s*return\s+404\s*;/m.test(loc.body) && !/proxy_pass/.test(loc.body);
const isInternalUpstream = (p) => p !== null && /^\/(?:v1\/)?internal(?:\/|$)/i.test(p);

export function checkInternalDeny(name, text) {
  const problems = [];
  const locations = parseLocations(text);
  const proxies = locations.filter(
    (l) => (l.mod === '' || l.mod === '^~') && /proxy_pass/.test(l.body) && !NON_APP_UPSTREAMS.has(upstreamHost(l) ?? ''),
  );
  const probes = new Set(KNOWN_SERVICE_INTERNAL);
  for (const p of proxies) {
    if (!p.pattern.endsWith('/')) continue;
    for (const tail of ['internal/probe', 'v1/internal/probe', 'internal', 'v1/internal', 'Internal/probe']) {
      probes.add(p.pattern + tail);
    }
  }
  for (const uri of probes) {
    const loc = selectLocation(locations, uri);
    if (isDeny(loc)) continue;
    const target = loc && proxies.includes(loc) ? upstreamPath(loc, uri) : null;
    if (isInternalUpstream(target) || KNOWN_SERVICE_INTERNAL.includes(uri)) {
      problems.push(`${name}: ${uri} reaches the upstream's internal route ${target ?? '(unknown)'} (add it to the internal-route deny regex)`);
    }
  }
  for (const uri of BROWSER_FACING_INTERNAL) {
    const loc = selectLocation(locations, uri);
    if (isDeny(loc)) problems.push(`${name}: browser-facing ${uri} is denied (the SPAs call it; exempt it in the deny regex)`);
  }
  return problems;
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
    problems.push(...checkInternalDeny(rel, text));
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
