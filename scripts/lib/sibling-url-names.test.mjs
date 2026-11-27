// "Where is <service> on the private network" is one fact per service. It kept being read under
// several names, only one of them provisioned on Railway, so the other readers silently went to
// the compose host there:
//   #303  banter-api: BANTER_API_URL (api, mcp-server) vs a bureau-api name and a worker name.
//   #305  helpdesk-api: HELPDESK_API_URL (mcp-server) vs the api's own name and blank-api's.
//   #305  bond-api: BOND_API_INTERNAL_URL read by book-api through a cast, declared nowhere.
// For each service this pins: one name across apps/*/src, read through env.ts (never a raw
// process.env read), and provisioned by the Railway catalog for every service that declares it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SERVICES } from '../deploy/shared/services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

/**
 * name: the one variable; family: every variable spelling for that service's URL;
 * allowed: other names in the family that mean a DIFFERENT fact, with the reason.
 */
const FACTS = [
  { name: 'BANTER_API_URL', family: /\bBANTER_[A-Z_]*URL\b/g, allowed: {} },
  {
    name: 'HELPDESK_API_URL',
    family: /\bHELPDESK_[A-Z_]*URL\b/g,
    allowed: { HELPDESK_URL: 'the public portal URL (helpdesk-api links in emails), not the private API base' },
  },
  {
    name: 'BOND_API_INTERNAL_URL',
    family: /\bBOND_[A-Z_]*URL\b/g,
    allowed: { BOND_API_URL: "mcp-server's /v1-suffixed REST base for its Bond tools, a different shape" },
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const sources = [];
for (const app of readdirSync(join(ROOT, 'apps'))) {
  const src = join(ROOT, 'apps', app, 'src');
  if (existsSync(src)) for (const f of walk(src)) sources.push({ app, file: f, text: readFileSync(f, 'utf8') });
}

for (const fact of FACTS) {
  test(`every ${fact.name.split('_')[0].toLowerCase()}-api URL variable under apps/*/src is ${fact.name}`, () => {
    const offenders = [];
    for (const { file, text } of sources) {
      for (const m of text.matchAll(fact.family)) {
        if (m[0] !== fact.name && !Object.hasOwn(fact.allowed, m[0])) offenders.push(`${relative(ROOT, file)}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test(`${fact.name} is read through env.ts, never as a raw process.env read`, () => {
    const raw = new RegExp(String.raw`process\.env(?:\.${fact.name}\b|\[['"]${fact.name}['"]\])`);
    const offenders = sources.filter(({ text }) => raw.test(text)).map(({ file }) => relative(ROOT, file));
    assert.deepEqual(offenders, []);
  });

  test(`every service whose env.ts declares ${fact.name} gets it from the Railway catalog`, () => {
    const readers = sources
      .filter(({ file, text }) => /[\\/]src[\\/]env\.ts$/.test(file) && text.includes(`${fact.name}:`))
      .map(({ app }) => app);
    assert.ok(readers.length > 0, `nothing declares ${fact.name}`);
    const missing = [];
    for (const app of readers) {
      const svc = APP_SERVICES.find((s) => s.dockerfile === `apps/${app}/Dockerfile`);
      if (!svc) continue; // not a deployed service
      const vars = [...(svc.env?.required ?? []), ...(svc.env?.optional ?? [])];
      if (!vars.includes(fact.name)) missing.push(svc.name);
    }
    assert.deepEqual(missing, []);
  });
}
