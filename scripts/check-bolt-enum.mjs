#!/usr/bin/env node
/**
 * Bolt source enum guard (issue #124).
 *
 * Asserts that the live Postgres enum `bolt_trigger_source` holds exactly the
 * values in BOLT_SOURCES (packages/shared/src/bolt-sources.ts). The enum cannot
 * be derived from the TypeScript list at runtime, so it is checked here instead,
 * against a database with every migration applied (the db-drift CI job).
 *
 * A value in BOLT_SOURCES that the database lacks means a migration is missing:
 * add `ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS '<name>';` in a new
 * numbered file. A value in the database that BOLT_SOURCES lacks means the list
 * lost an entry (Postgres cannot drop enum values, so restore it to the list).
 *
 * Connection: DATABASE_URL, else POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_HOST/
 * POSTGRES_PORT/POSTGRES_DB (same defaults as scripts/db-check.mjs).
 * Exit codes: 0 match, 1 drift, 2 setup error.
 */

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, compareSourceSets, loadBoltSources } from './lib/bolt-sources.mjs';

const t0 = Date.now();
const log = (msg) => console.log(`[bolt-enum +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

function loadPostgres() {
  for (const anchor of [REPO_ROOT, join(REPO_ROOT, 'apps', 'api')]) {
    try {
      const r = createRequire(pathToFileURL(join(anchor, 'package.json')).href);
      const mod = r('postgres');
      return mod.default ?? mod;
    } catch {
      // try next anchor
    }
  }
  // pnpm fallback (same as scripts/db-check.mjs): the package may not be hoisted, and
  // workspace symlinks do not resolve when the repo is bind-mounted into a container.
  try {
    const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
    const match = readdirSync(pnpmDir).find((n) => /^postgres@\d/.test(n));
    if (match) {
      const r = createRequire(pathToFileURL(join(pnpmDir, match, 'node_modules', 'postgres', 'package.json')).href);
      const mod = r('./');
      return mod.default ?? mod;
    }
  } catch {
    // fall through
  }
  return null;
}

const expected = loadBoltSources();
log(`BOLT_SOURCES has ${expected.length} values`);

const postgres = loadPostgres();
if (!postgres) {
  console.error('[bolt-enum] could not resolve the `postgres` package; run `pnpm install` first');
  process.exit(2);
}

const url =
  process.env.DATABASE_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'bigbluebam'}:${process.env.POSTGRES_PASSWORD ?? ''}@${
    process.env.POSTGRES_HOST ?? 'localhost'
  }:${process.env.POSTGRES_PORT ?? '5432'}/${process.env.POSTGRES_DB ?? 'bigbluebam'}`;

log('querying enum_range(NULL::bolt_trigger_source)');
const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
let actual;
try {
  const rows = await sql`SELECT unnest(enum_range(NULL::bolt_trigger_source))::text AS v`;
  actual = rows.map((r) => r.v);
} catch (err) {
  console.error(`[bolt-enum] query failed: ${err.message}`);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(2);
}
await sql.end({ timeout: 1 });

const { missingInDb, extraInDb } = compareSourceSets(expected, actual);
if (missingInDb.length === 0 && extraInDb.length === 0) {
  log(`OK: bolt_trigger_source matches BOLT_SOURCES (${actual.length} values)`);
  process.exit(0);
}
if (missingInDb.length) {
  console.error(
    `[bolt-enum] bolt_trigger_source is missing ${missingInDb.length} value(s) from BOLT_SOURCES: ${missingInDb.join(', ')}`,
  );
  console.error("  Fix: add a migration with ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS '<name>';");
}
if (extraInDb.length) {
  console.error(
    `[bolt-enum] bolt_trigger_source has ${extraInDb.length} value(s) not in BOLT_SOURCES: ${extraInDb.join(', ')}`,
  );
  console.error('  Fix: add them back to packages/shared/src/bolt-sources.ts (enum values cannot be dropped).');
}
process.exit(1);
