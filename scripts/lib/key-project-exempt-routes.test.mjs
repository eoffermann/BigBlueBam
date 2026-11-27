// node --test scripts/lib/key-project-exempt-routes.test.mjs
//
// #367: project-restricted API keys were refused on GET /auth/me, the identity probe the MCP
// policy gate depends on. Identity-only routes now opt out of the final gate with
// `config: { keyProjectExempt }`. This guard keeps that list short and explicit: the real
// GET /auth/me carries the flag, PATCH /auth/me does not, and no other route file may add one
// without being listed here with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// file (relative, forward slashes) -> why its routes may be exempt
const ALLOWED = {
  'apps/api/src/routes/auth.routes.ts': 'GET /auth/me: the caller identity, nothing else',
  'apps/api/src/routes/agent-policies.routes.ts': 'POST /v1/agent-policies/:id/check, self only',
};

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('GET /auth/me is exempt and PATCH /auth/me is not', () => {
  const src = readFileSync(join(ROOT, 'apps/api/src/routes/auth.routes.ts'), 'utf8');
  const get = src.match(/fastify\.get\(\s*'\/auth\/me'\s*,\s*\{([^}]*\})?[^}]*\}/);
  assert.ok(get, 'GET /auth/me declaration not found');
  assert.match(get[0], /keyProjectExempt:\s*true/);
  const patch = src.match(/fastify\.patch\(\s*'\/auth\/me'\s*,\s*\{[^}]*\}/);
  assert.ok(patch, 'PATCH /auth/me declaration not found');
  assert.doesNotMatch(patch[0], /keyProjectExempt/);
});

test('only the listed route files declare keyProjectExempt', () => {
  const offenders = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const dir = join(ROOT, 'apps', app, 'src', 'routes');
    try {
      statSync(dir);
    } catch {
      continue;
    }
    for (const f of tsFiles(dir)) {
      const rel = relative(ROOT, f).replace(/\\/g, '/');
      if (/keyProjectExempt/.test(readFileSync(f, 'utf8')) && !(rel in ALLOWED)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
