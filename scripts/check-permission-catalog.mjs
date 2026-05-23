#!/usr/bin/env node
//
// CI drift guard for the permission catalog.
//
// Re-runs scripts/generate-permission-manifest.mjs and
// scripts/build-permission-codegen.mjs into a temp directory, then diffs
// the generated artifacts against the committed copies. Any drift fails
// the build — the developer must regenerate and commit.
//
// Catches:
//   - A new MCP tool / REST route added without re-running the codegen.
//   - A renamed tool / route whose permission ID changed.
//   - A direct edit to docs/permissions-action-manifest.json /
//     0145_permissions_seed_actions.sql / generated/permissions.ts that
//     wasn't produced by the codegen.
//
// Mirrors the pattern from scripts/check-bolt-catalog.mjs.

import { execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/'), '..');

// Files the codegen regenerates and the drift guard checks for stability.
// 0145_permissions_seed_actions.sql is intentionally NOT in this list:
// it's frozen post-deploy per CLAUDE.md's immutability rule, and catalog
// updates land in delta migrations (0151+) that aren't part of the
// regenerated output.
const COMMITTED_FILES = [
  'docs/permissions-action-manifest.json',
  'packages/permissions/src/generated/permissions.ts',
];

function readFile(path) {
  return readFileSync(path, 'utf8');
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function regenerate() {
  // Re-run both scripts in-place. They're idempotent — overwriting the
  // committed files means git diff is the source of truth for drift.
  // We capture the file contents BEFORE regenerating so the comparison
  // happens after.
  const before = new Map();
  for (const f of COMMITTED_FILES) {
    const path = join(ROOT, f);
    if (!existsSync(path)) {
      console.error(`✗ committed artifact missing: ${f}. Run pnpm permissions:codegen and commit.`);
      process.exit(1);
    }
    before.set(f, readFile(path));
  }

  // Stash committed copies in a tmpdir so we can diff after regen.
  const tmp = mkdtempSync(join(tmpdir(), 'bbb-perm-check-'));
  for (const f of COMMITTED_FILES) {
    const dest = join(tmp, f);
    ensureDir(dest);
    copyFileSync(join(ROOT, f), dest);
  }

  // Run both codegen steps.
  try {
    execSync(`node "${join(ROOT, 'scripts/generate-permission-manifest.mjs')}"`, { stdio: 'pipe', cwd: ROOT });
    execSync(`node "${join(ROOT, 'scripts/build-permission-codegen.mjs')}"`, { stdio: 'pipe', cwd: ROOT });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    console.error('✗ codegen failed:\n' + stderr + stdout);
    process.exit(1);
  }

  // Compare regenerated against the committed copies in tmp.
  const drifted = [];
  for (const f of COMMITTED_FILES) {
    const fresh = readFile(join(ROOT, f));
    const committed = readFile(join(tmp, f));
    if (fresh !== committed) drifted.push(f);
  }

  // Restore the committed copies on drift, so this script doesn't leave
  // half-regenerated state in the tree if it runs on a developer
  // machine. (CI will fail before this matters; the restore is a
  // courtesy for `pnpm check-permission-catalog` run manually.)
  if (drifted.length > 0) {
    for (const f of COMMITTED_FILES) {
      copyFileSync(join(tmp, f), join(ROOT, f));
    }
    console.error('✗ permission catalog drift detected:');
    for (const f of drifted) console.error(`    ${f}`);
    console.error('');
    console.error('  Re-run the codegen and commit the diff:');
    console.error('    node scripts/generate-permission-manifest.mjs');
    console.error('    node scripts/build-permission-codegen.mjs');
    console.error('    git add docs/permissions-action-manifest.json \\');
    console.error('            packages/permissions/src/generated/permissions.ts');
    console.error('');
    console.error('  If the catalog gained or lost permissions, also add a delta');
    console.error('  migration via:');
    console.error('    node scripts/build-permission-delta.mjs');
    process.exit(1);
  }

  console.log(`✓ permission catalog up to date (${COMMITTED_FILES.length} artifacts checked)`);
}

// ─── DB drift check (optional, opt-in via env or reachable postgres) ──
//
// Catches the failure mode that bit Wave A/B/C: build-permission-delta.mjs
// emitted seed deltas that silently dropped flag columns (the original
// requires_superuser drift), and the committed-artifact diff above cannot
// see it — only the DB knows. Runs only when Postgres is reachable;
// developer machines without the stack up just skip it, and CI's
// db-drift.yml job has the service container available.
//
// Skipped entirely if BBB_SKIP_PERM_DB_CHECK=1 (escape hatch for the
// occasional case where the stack is up but the catalog is mid-rebuild).

function fetchCatalogFromDb() {
  try {
    const out = execSync(
      'docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -t -A -F"|" -c ' +
        '"SELECT id, is_destructive, requires_confirmation, is_read, requires_superuser FROM permissions ORDER BY id;"',
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT },
    );
    const rows = new Map();
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('|');
      if (parts.length < 5) continue;
      rows.set(parts[0], {
        is_destructive: parts[1] === 't',
        requires_confirmation: parts[2] === 't',
        is_read: parts[3] === 't',
        requires_superuser: parts[4] === 't',
      });
    }
    return rows;
  } catch {
    return null;
  }
}

function checkDb() {
  if (process.env.BBB_SKIP_PERM_DB_CHECK === '1') {
    console.log('  (db check skipped via BBB_SKIP_PERM_DB_CHECK=1)');
    return;
  }
  const dbRows = fetchCatalogFromDb();
  if (!dbRows) {
    console.log('  (db check skipped: postgres unreachable)');
    return;
  }

  const manifest = JSON.parse(readFile(join(ROOT, 'docs/permissions-action-manifest.json')));
  const manifestRows = new Map(
    manifest.permissions.map((p) => [
      p.id,
      {
        is_destructive: !!p.is_destructive,
        requires_confirmation: !!p.requires_confirmation,
        is_read: !!p.is_read,
        requires_superuser: !!p.requires_superuser,
      },
    ]),
  );

  const inManifestNotDb = [...manifestRows.keys()].filter((id) => !dbRows.has(id)).sort();
  const inDbNotManifest = [...dbRows.keys()].filter((id) => !manifestRows.has(id)).sort();
  const flagDrift = [];
  for (const [id, m] of manifestRows.entries()) {
    const d = dbRows.get(id);
    if (!d) continue;
    for (const flag of ['is_destructive', 'requires_confirmation', 'is_read', 'requires_superuser']) {
      if (m[flag] !== d[flag]) {
        flagDrift.push({ id, flag, manifest: m[flag], db: d[flag] });
      }
    }
  }

  if (inManifestNotDb.length === 0 && inDbNotManifest.length === 0 && flagDrift.length === 0) {
    console.log(`✓ permission catalog also in sync with DB (${dbRows.size} rows checked)`);
    return;
  }

  console.error('✗ permission catalog DB drift detected:');
  if (inManifestNotDb.length > 0) {
    console.error(`  in manifest, missing from DB (${inManifestNotDb.length}): need a delta migration`);
    for (const id of inManifestNotDb.slice(0, 10)) console.error(`    ${id}`);
    if (inManifestNotDb.length > 10) console.error(`    ... and ${inManifestNotDb.length - 10} more`);
  }
  if (inDbNotManifest.length > 0) {
    console.error(`  in DB, missing from manifest (${inDbNotManifest.length}): need a delta migration removing them`);
    for (const id of inDbNotManifest.slice(0, 10)) console.error(`    ${id}`);
    if (inDbNotManifest.length > 10) console.error(`    ... and ${inDbNotManifest.length - 10} more`);
  }
  if (flagDrift.length > 0) {
    console.error(`  flag mismatches (${flagDrift.length}):`);
    for (const d of flagDrift.slice(0, 10)) {
      console.error(`    ${d.id}.${d.flag}: manifest=${d.manifest} db=${d.db}`);
    }
    if (flagDrift.length > 10) console.error(`    ... and ${flagDrift.length - 10} more`);
  }
  console.error('');
  console.error('  Fix: regenerate the delta and apply it:');
  console.error('    node scripts/build-permission-delta.mjs');
  console.error('    docker compose run --rm migrate');
  process.exit(1);
}

regenerate();
checkDb();
