// #303: "where is banter-api on the private network" is one fact. It was read under three names
// (BANTER_API_URL in api and mcp-server, BANTER_INTERNAL_URL in bureau-api, BANTER_API_INTERNAL_URL
// in the worker) and only the first was provisioned on Railway, so Bureau leave-a-note DMs and the
// transcription callback went to http://banter-api:4002 (wrong host and port there). This pins the
// fact to one name, declared in each reader's env.ts, and provisioned for every reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SERVICES } from '../deploy/shared/services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = 'BANTER_API_URL';
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

function appSources() {
  const files = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    if (existsSync(src)) for (const f of walk(src)) files.push({ app, file: f });
  }
  return files;
}

const sources = appSources();

test('every banter-api URL variable read under apps/*/src is BANTER_API_URL', () => {
  const offenders = [];
  for (const { file } of sources) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\bBANTER_[A-Z_]*URL\b/g)) {
      if (m[0] !== NAME) offenders.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('BANTER_API_URL is read through env.ts, never as a raw process.env read', () => {
  const offenders = sources
    .filter(({ file }) => /process\.env\.BANTER_API_URL|process\.env\[['"]BANTER_API_URL['"]\]/.test(readFileSync(file, 'utf8')))
    .map(({ file }) => relative(ROOT, file));
  assert.deepEqual(offenders, []);
});

test('every service whose env.ts declares BANTER_API_URL gets it from the Railway catalog', () => {
  const readers = sources
    .filter(({ file }) => /[\\/]src[\\/]env\.ts$/.test(file) && readFileSync(file, 'utf8').includes(`${NAME}:`))
    .map(({ app }) => app);
  assert.ok(readers.includes('api') && readers.includes('bureau-api') && readers.includes('worker'));
  const missing = [];
  for (const app of readers) {
    const svc = APP_SERVICES.find((s) => s.dockerfile === `apps/${app}/Dockerfile`);
    if (!svc) continue; // not a deployed service
    const vars = [...(svc.env?.required ?? []), ...(svc.env?.optional ?? [])];
    if (!vars.includes(NAME)) missing.push(svc.name);
  }
  assert.deepEqual(missing, []);
});
