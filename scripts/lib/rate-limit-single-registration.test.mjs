// #411: one global rate-limit registration for every Fastify service.
//
// BBB_E2E_PERMISSIVE_RATE_LIMIT used to be honoured by api and helpdesk-api only, because each
// service registered @fastify/rate-limit by hand; a parallel Playwright run then tripped the
// 100/min ceiling on every other service (bastion-api surfaced it). The rule now lives once, in
// registerGlobalRateLimit (packages/service-health/src/rate-limit.ts). This test keeps it that way:
//   1. no service source imports @fastify/rate-limit directly;
//   2. every service that depends on @fastify/rate-limit calls registerGlobalRateLimit;
//   3. docker-compose.yml passes the flag to each of them, and docker-compose.dev.yml turns it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED_HOME = 'packages/service-health/src/rate-limit.ts';

/** Matches a value import / require / dynamic import of @fastify/rate-limit (type-only imports are fine). */
export function importsRateLimitDirectly(source) {
  const stripped = source.replace(/^\s*import\s+type\s[^;]*;/gm, '');
  return /(?:from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"]@fastify\/rate-limit['"]/m.test(stripped);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

function rateLimitedServices() {
  return readdirSync(join(repoRoot, 'apps')).filter((a) => {
    const pj = join(repoRoot, 'apps', a, 'package.json');
    if (!existsSync(pj)) return false;
    const { dependencies = {} } = JSON.parse(readFileSync(pj, 'utf8'));
    return '@fastify/rate-limit' in dependencies;
  });
}

/** The lines of one top-level service block in a compose file. */
export function serviceBlock(composeText, name) {
  const lines = composeText.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {0,2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('the detector matches value imports and ignores type-only ones', () => {
  assert.equal(importsRateLimitDirectly("import rateLimit from '@fastify/rate-limit';"), true);
  assert.equal(importsRateLimitDirectly("import { default as rl } from \"@fastify/rate-limit\";"), true);
  assert.equal(importsRateLimitDirectly("const rl = await import('@fastify/rate-limit');"), true);
  assert.equal(importsRateLimitDirectly("const rl = require('@fastify/rate-limit');"), true);
  assert.equal(importsRateLimitDirectly("import type { RateLimitOptions } from '@fastify/rate-limit';"), false);
  assert.equal(importsRateLimitDirectly('// route-level @fastify/rate-limit config'), false);
});

test('no service registers @fastify/rate-limit directly', () => {
  const offenders = [];
  for (const app of readdirSync(join(repoRoot, 'apps'))) {
    const src = join(repoRoot, 'apps', app, 'src');
    if (!existsSync(src)) continue;
    for (const file of walk(src)) {
      if (importsRateLimitDirectly(readFileSync(file, 'utf8'))) offenders.push(relative(repoRoot, file));
    }
  }
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    const src = join(repoRoot, 'packages', pkg, 'src');
    if (!existsSync(src)) continue;
    for (const file of walk(src)) {
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      if (rel === SHARED_HOME || /\.test\.[a-z]+$/.test(rel)) continue;
      if (importsRateLimitDirectly(readFileSync(file, 'utf8'))) offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `register the global limit with registerGlobalRateLimit from @bigbluebam/service-health, not @fastify/rate-limit directly: ${offenders.join(', ')}`,
  );
});

test('every rate-limited service calls registerGlobalRateLimit', () => {
  const services = rateLimitedServices();
  assert.ok(services.length >= 20, `expected the Fastify services, found ${services.length}`);
  const missing = services.filter((app) => {
    const files = walk(join(repoRoot, 'apps', app, 'src'));
    return !files.some((f) => /registerGlobalRateLimit\s*\(/.test(readFileSync(f, 'utf8')));
  });
  assert.deepEqual(missing, [], `services without registerGlobalRateLimit: ${missing.join(', ')}`);
});

test('docker-compose.yml passes the flag and multiplier to every rate-limited service', () => {
  const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
  const missing = [];
  for (const svc of rateLimitedServices()) {
    const block = serviceBlock(compose, svc);
    if (
      !block ||
      !/BBB_E2E_PERMISSIVE_RATE_LIMIT[:=]\s*\$\{BBB_E2E_PERMISSIVE_RATE_LIMIT:-\}/.test(block) ||
      !/RATE_LIMIT_E2E_MULTIPLIER[:=]\s*\$\{RATE_LIMIT_E2E_MULTIPLIER:-\}/.test(block)
    ) {
      missing.push(svc);
    }
  }
  assert.deepEqual(missing, [], `docker-compose.yml services missing the e2e rate-limit vars: ${missing.join(', ')}`);
});

test('docker-compose.dev.yml turns the flag on for every rate-limited service', () => {
  const dev = readFileSync(join(repoRoot, 'docker-compose.dev.yml'), 'utf8');
  const missing = rateLimitedServices().filter((svc) => {
    const block = serviceBlock(dev, svc);
    return !block || !/BBB_E2E_PERMISSIVE_RATE_LIMIT:\s*"1"/.test(block);
  });
  assert.deepEqual(missing, [], `docker-compose.dev.yml services not permissive: ${missing.join(', ')}`);
});
