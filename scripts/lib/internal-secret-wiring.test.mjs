// Every Node service that sends or checks the shared internal service secret must actually be
// given INTERNAL_SERVICE_SECRET, in docker-compose.yml AND in the Railway service catalog
// (scripts/deploy/shared/services.mjs). #248: helpdesk-api publishes Bolt events through
// @bigbluebam/shared's publishBoltEvent, which sends X-Internal-Secret from
// process.env.INTERNAL_SERVICE_SECRET, but neither compose nor the catalog passed the variable,
// so every helpdesk event reached bolt-api with an empty secret and was refused with 401.
//
// The fact this test owns: "which services need INTERNAL_SERVICE_SECRET" is derived from the
// code (a service that names the variable or calls a shared helper that reads it), never from a
// hand-kept list, so a new caller cannot be forgotten in one deploy target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Shared helpers that read INTERNAL_SERVICE_SECRET from process.env on the caller's behalf.
const SHARED_SECRET_READERS = [
  /\bpublishBoltEvent(Checked)?\s*\(/,
  /from\s+['"]@bigbluebam\/shared\/visibility-client['"]/,
  /\bINTERNAL_SERVICE_SECRET\b/,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__' || name === 'test') continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.(test|spec|nodetest)\.[a-z]+$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Node service apps (have a src/ and a Dockerfile) whose runtime code needs the secret. */
function servicesNeedingSecret() {
  const apps = readdirSync(join(ROOT, 'apps')).filter((a) => {
    const base = join(ROOT, 'apps', a);
    return existsSync(join(base, 'src')) && existsSync(join(base, 'Dockerfile')) && existsSync(join(base, 'package.json'));
  });
  const needing = [];
  for (const app of apps) {
    // SPAs are built into the frontend nginx image; they never hold a server secret.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', app, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}) };
    if (!deps.fastify && app !== 'worker') continue;
    const files = walk(join(ROOT, 'apps', app, 'src'));
    if (files.some((f) => SHARED_SECRET_READERS.some((re) => re.test(readFileSync(f, 'utf8'))))) needing.push(app);
  }
  return needing;
}

/** The environment block of one top-level compose service, as text. */
function composeServiceBlock(compose, service) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}

test('the derived list is not empty and includes the known callers', () => {
  const needing = servicesNeedingSecret();
  for (const known of ['api', 'bolt-api', 'worker', 'helpdesk-api']) assert.ok(needing.includes(known), `${known} should need INTERNAL_SERVICE_SECRET`);
});

test('every service that uses INTERNAL_SERVICE_SECRET receives it from docker-compose.yml', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const missing = [];
  for (const svc of servicesNeedingSecret()) {
    const block = composeServiceBlock(compose, svc);
    if (block === null) continue; // not a compose service (checked by the catalog test below)
    // Both compose environment shapes: the map form (`VAR: value`) and the list form (`- VAR=value`).
    if (!/^\s+(-\s+)?INTERNAL_SERVICE_SECRET[:=]/m.test(block)) missing.push(svc);
  }
  assert.deepEqual(missing, [], `compose services missing INTERNAL_SERVICE_SECRET: ${missing.join(', ')}`);
});

test('every service that uses INTERNAL_SERVICE_SECRET lists it in the Railway catalog', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'scripts', 'deploy', 'shared', 'services.mjs')).href);
  const catalog = [...(mod.APP_SERVICES ?? []), ...(mod.JOB_SERVICES ?? [])];
  assert.ok(catalog.length > 0, 'services.mjs exports APP_SERVICES / JOB_SERVICES');
  const byName = new Map(catalog.map((s) => [s.name, s]));
  const missing = [];
  for (const svc of servicesNeedingSecret()) {
    const entry = byName.get(svc);
    if (!entry) continue;
    const vars = [...(entry.env?.required ?? []), ...(entry.env?.optional ?? [])];
    if (!vars.includes('INTERNAL_SERVICE_SECRET')) missing.push(svc);
  }
  assert.deepEqual(missing, [], `catalog entries missing INTERNAL_SERVICE_SECRET: ${missing.join(', ')}`);
});
