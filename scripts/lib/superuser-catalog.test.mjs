// A permission that only a SuperUser-only route checks must be catalogued
// requires_superuser = true.
//
// The api's SuperUser-only route files mount the requirePlatformSuperuser
// guard, which blocks non-SuperUsers in every BBB_PERMISSIONS_ENFORCE posture.
// The permission resolver is a second gate (and the only gate for an MCP tool
// that maps to the same id): under enforce=on it refuses a non-SuperUser only
// when the catalog row says requires_superuser. When the flag was missing, the
// decision fell through to group defaults and an org Owner's builtin group
// granted it (#298: promote self to SuperUser, impersonate, edit platform mail
// settings). This test reads the route files and the generated manifest, so a
// new SuperUser-only route whose permission is not flagged fails here, and it
// reads the migrations so the DB catalog cannot lag the manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/'), '..', '..');
const ROUTES = join(ROOT, 'apps/api/src/routes');
const MIGRATIONS = join(ROOT, 'infra/postgres/migrations');

// Routes the guard exempts on purpose (require-platform-superuser.ts
// EXEMPT_ROUTES): stop-impersonation runs while request.user is the
// impersonated, non-SuperUser target.
const EXEMPT = new Set(['bam.platform_stop_impersonation.create']);

// Single-key read that ordinary app code depends on; secret values are masked.
const AUTHENTICATED_READS = new Set(['bam.system_setting.get']);

const PERMISSION_CALL = /(?:requireCan|shadowOnly)\('([^']+)'\)/g;

/** Permission ids referenced by SuperUser-only route code, minus ids shared with other routes. */
export function superuserOnlyPermissionIds(files) {
  const guarded = new Set();
  const elsewhere = new Set();
  for (const { name, src } of files) {
    const fileGuarded = /addHook\(\s*'preHandler'\s*,\s*requirePlatformSuperuser\s*\)/.test(src);
    if (fileGuarded) {
      for (const m of src.matchAll(PERMISSION_CALL)) guarded.add(m[1]);
      continue;
    }
    // Route-level guard: a preHandler array that lists requirePlatformSuperuser.
    for (const block of src.split(/fastify\.(?:get|post|put|patch|delete)\b/).slice(1)) {
      const opts = block.slice(0, block.search(/async\s*\(/) > 0 ? block.search(/async\s*\(/) : block.length);
      const target = /requirePlatformSuperuser/.test(opts) ? guarded : elsewhere;
      for (const m of opts.matchAll(PERMISSION_CALL)) target.add(m[1]);
    }
    void name;
  }
  return [...guarded].filter((id) => !elsewhere.has(id) && !EXEMPT.has(id) && !AUTHENTICATED_READS.has(id)).sort();
}

/** Ids a set of migration bodies flips to requires_superuser = true (or seeds that way). */
export function idsFlaggedByMigrations(sqlBodies) {
  const flagged = new Set();
  for (const raw of sqlBodies) {
    const sql = raw.replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/UPDATE\s+permissions\s+SET\s+requires_superuser\s*=\s*true\s+WHERE\s+id\s+IN\s*\(([^)]*)\)/gi)) {
      for (const id of m[1].matchAll(/'([^']+)'/g)) flagged.add(id[1]);
    }
    for (const ins of sql.matchAll(/INSERT\s+INTO\s+permissions\s*\(([^)]*)\)\s*VALUES([\s\S]*?);/gi)) {
      const cols = ins[1].split(',').map((c) => c.trim());
      const idCol = cols.indexOf('id');
      const suCol = cols.indexOf('requires_superuser');
      if (idCol < 0 || suCol < 0) continue;
      for (const tuple of ins[2].matchAll(/\(((?:'(?:[^']|'')*'|[^()'])*)\)/g)) {
        const values = [...tuple[1].matchAll(/'((?:[^']|'')*)'|([^,\s][^,]*)/g)].map((v) => (v[1] ?? v[2]).trim());
        if (values[suCol] === 'true') flagged.add(values[idCol]);
      }
    }
  }
  return flagged;
}

function routeFiles() {
  return readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, src: readFileSync(join(ROUTES, name), 'utf8') }));
}

test('the scanner sees a guarded file and a route-level guard', () => {
  const ids = superuserOnlyPermissionIds([
    { name: 'a.ts', src: "fastify.addHook('preHandler', requirePlatformSuperuser);\nfastify.get('/x', { preHandler: [fastify.requireCan('a.b.c')] }, async () => {});" },
    { name: 'b.ts', src: "fastify.put('/y', { preHandler: [requireAuth, requirePlatformSuperuser, fastify.requireCan('d.e.f')] }, async () => {});\nfastify.get('/z', { preHandler: [fastify.requireCan('g.h.i')] }, async () => {});" },
  ]);
  assert.deepEqual(ids, ['a.b.c', 'd.e.f']);
});

test('every permission checked only by a SuperUser-only route is requires_superuser in the manifest', () => {
  const ids = superuserOnlyPermissionIds(routeFiles());
  assert.ok(ids.length > 20, `expected the platform/superuser trees to be found, got ${ids.length}`);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/permissions-action-manifest.json'), 'utf8'));
  const byId = new Map(manifest.permissions.map((p) => [p.id, p]));
  const missing = ids.filter((id) => byId.get(id)?.requires_superuser !== true);
  assert.deepEqual(missing, [], `add these to REQUIRES_SUPERUSER_IDS in scripts/generate-permission-manifest.mjs and a delta migration: ${missing.join(', ')}`);
});

test('every such permission is flagged by a migration too', () => {
  const ids = superuserOnlyPermissionIds(routeFiles());
  const bodies = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
  const flagged = idsFlaggedByMigrations(bodies);
  const missing = ids.filter((id) => !flagged.has(id) && !id.startsWith('bam.superuser_'));
  // bam.superuser_* rows are seeded already flagged by the generated seed/delta
  // migrations, whose row format the second regex above reads; the remainder
  // must come from an explicit UPDATE.
  assert.deepEqual(missing, [], `no migration sets requires_superuser = true for: ${missing.join(', ')}`);
});
