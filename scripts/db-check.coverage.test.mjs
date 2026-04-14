#!/usr/bin/env node
/**
 * db-check.coverage.test.mjs - regression test for SCHEMA_ROOTS coverage.
 *
 * Closes Platform_Plan.md (2026-04-13-revised) gap 2.1.4. Asserts that the
 * SCHEMA_ROOTS list exported from `db-check.mjs` actually walks every
 * `apps/{name}/src/db/schema/` directory present on disk.
 *
 * Without this guard, adding a new product (a new `apps/<name>` directory
 * with its own Drizzle schema) silently drops out of the drift guard, and
 * CI happily certifies a schema it has never inspected. That was gap 2.1.1
 * before the SCHEMA_ROOTS refactor; this test prevents the same class of
 * silent omission from coming back.
 *
 * Run via:  node scripts/db-check.coverage.test.mjs
 *
 * Exit codes:
 *   0 - every schema directory on disk is in SCHEMA_ROOTS
 *   1 - one or more schema directories are missing from SCHEMA_ROOTS
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_ROOTS } from './db-check.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const APPS_DIR = join(repoRoot, 'apps');

/**
 * Walk apps/ ourselves rather than trusting the same code that produced
 * SCHEMA_ROOTS, so the test is genuinely independent of the implementation.
 */
function discoverSchemaDirs() {
  const out = [];
  let entries;
  try {
    entries = readdirSync(APPS_DIR, { withFileTypes: true });
  } catch (err) {
    console.error(`Could not read ${APPS_DIR}: ${err?.message ?? err}`);
    process.exit(2);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(APPS_DIR, e.name, 'src', 'db', 'schema');
    try {
      if (statSync(candidate).isDirectory()) out.push(candidate);
    } catch {
      // Directory does not exist (e.g. apps/voice-agent which is Python).
    }
  }
  return out.sort();
}

const onDisk = discoverSchemaDirs();

const normalize = (p) => relative(repoRoot, p).replaceAll('\\', '/');
const onDiskRel = onDisk.map(normalize);
const inListRel = SCHEMA_ROOTS.map(normalize);

const missing = onDiskRel.filter((rel) => !inListRel.includes(rel));
const extra = inListRel.filter((rel) => !onDiskRel.includes(rel));

let failed = false;

if (missing.length > 0) {
  failed = true;
  console.error(
    'FAIL: db-check.mjs SCHEMA_ROOTS is missing the following schema directories on disk:',
  );
  for (const rel of missing) {
    console.error('  - ' + rel);
  }
  console.error(
    '\nFix: re-export SCHEMA_ROOTS from scripts/db-check.mjs so it walks every apps/<name>/src/db/schema directory automatically.',
  );
}

if (extra.length > 0) {
  failed = true;
  console.error(
    'FAIL: db-check.mjs SCHEMA_ROOTS lists schema directories that do not exist on disk:',
  );
  for (const rel of extra) {
    console.error('  - ' + rel);
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `OK: SCHEMA_ROOTS covers all ${onDiskRel.length} schema director${
    onDiskRel.length === 1 ? 'y' : 'ies'
  } under apps/`,
);
for (const rel of inListRel) {
  console.log('  - ' + rel);
}
process.exit(0);
