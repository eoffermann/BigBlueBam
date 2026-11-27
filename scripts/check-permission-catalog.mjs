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
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

/**
 * True when a regenerated artifact matches the committed copy, ignoring line
 * endings. The generators write LF; a Windows checkout with core.autocrlf
 * gives the working copy CRLF, which is not drift (git normalizes it on
 * commit). Issue #361: the byte comparison reported false drift on every
 * Windows session.
 */
export function sameArtifactText(fresh, committed) {
  const norm = (s) => s.replace(/\r\n?/g, '\n');
  return norm(fresh) === norm(committed);
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
    console.error(`✗ codegen failed:\n${stderr}${stdout}`);
    process.exit(1);
  }

  // Compare regenerated against the committed copies in tmp.
  const drifted = [];
  for (const f of COMMITTED_FILES) {
    const fresh = readFile(join(ROOT, f));
    const committed = readFile(join(tmp, f));
    if (!sameArtifactText(fresh, committed)) drifted.push(f);
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

// ─── Route coverage (issue #153) ──────────────────────────────────────
//
// Blueprint and Bureau shipped with routes that contributed nothing to the
// catalog, so requireCan could not gate them and no built-in group granted
// anything for them, and the manifest diff above could not notice (a missing
// app produces no drift). Every app with apps/<dir>/src/routes must now
// contribute at least one catalog action from its route files, either
// path-derived by the generator's route scan or as a literal id passed to
// requireCan()/can() in a route file, unless it is exempted below with a
// reason. Every literal id a route file passes must also exist in the catalog.

const ROUTE_COVERAGE_EXEMPT = {
  'mcp-server': 'MCP transport routes (/tools/call, /mcp); its tools are catalogued by the tool scan',
};

const LITERAL_ID_RE = /(?:requireCan|\bcan)\(\s*['"`]([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)['"`]/g;

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

export function routeCoverageProblems(root = ROOT, manifest = null) {
  const m = manifest ?? JSON.parse(readFile(join(root, 'docs/permissions-action-manifest.json')));
  const catalog = new Set(m.permissions.map((p) => p.id));
  const appsDir = join(root, 'apps');
  const problems = [];
  const coverage = {};
  for (const dir of readdirSync(appsDir).sort()) {
    const routesDir = join(appsDir, dir, 'src/routes');
    if (!existsSync(routesDir)) continue;
    const prefix = dir === 'api' ? 'bam' : dir.replace(/-api$/, '');
    const literal = new Set();
    for (const file of listTsFiles(routesDir)) {
      const text = readFile(file);
      for (const match of text.matchAll(LITERAL_ID_RE)) {
        if (catalog.has(match[1])) literal.add(match[1]);
        else problems.push(`apps/${dir}: route file ${file.slice(routesDir.length + 1)} passes '${match[1]}', which is not in the catalog`);
      }
    }
    const scanned = m.permissions.filter(
      (p) => p.app === prefix && p.sources?.some((s) => s.source === 'rest' && !String(s.ref).startsWith('hand_authored')),
    ).length;
    coverage[dir] = scanned + literal.size;
    if (Object.prototype.hasOwnProperty.call(ROUTE_COVERAGE_EXEMPT, dir)) continue;
    if (coverage[dir] === 0) {
      problems.push(
        `apps/${dir}: its route files contribute zero catalog actions. Gate its routes with requireCan('<app>.<resource>.<verb>') ids (hand-authored in scripts/generate-permission-manifest.mjs, plus a delta migration and built-in group defaults), or add it to ROUTE_COVERAGE_EXEMPT in scripts/check-permission-catalog.mjs with a reason.`,
      );
    }
  }
  for (const dir of Object.keys(ROUTE_COVERAGE_EXEMPT)) {
    if (!existsSync(join(appsDir, dir, 'src/routes'))) {
      problems.push(`ROUTE_COVERAGE_EXEMPT lists '${dir}', which has no apps/${dir}/src/routes`);
    }
  }
  return { problems, coverage };
}

function checkRouteCoverage() {
  const { problems, coverage } = routeCoverageProblems();
  if (problems.length > 0) {
    console.error('✗ permission catalog route coverage:');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
  }
  const apps = Object.keys(coverage).length;
  console.log(`✓ every route-bearing app contributes catalog actions (${apps} apps, ${Object.keys(ROUTE_COVERAGE_EXEMPT).length} exempt)`);
}

// ─── WebSocket frame coverage (issue #166) ────────────────────────────
//
// The route scan above only sees requireCan()/can() in HTTP route files, so it
// reported Bureau as fully covered while its WebSocket hub ran knock, summon,
// door, chat and presence frames with no catalog check at all. Each hub listed
// here must map EVERY `case '<frame>':` in its handler to a list of catalog ids
// (an empty list is an explicit "always allowed"), every mapped id must exist in
// the catalog, no map key may be stale, and the handler must still call the gate.
//
// Issue #177 extended this from Bureau to every app socket. Each hub's map lives
// in one module and is enforced by the shared gate (createWsFrameGate in
// @bigbluebam/permissions). `frames` says how the handler's frame types are
// found:
//   - 'json'  (default): `case '<t>':`, `.type === '<t>'` and `z.literal('<t>')`.
//   - 'yjs':  the binary y-websocket frames classifyYjsFrame names; the handler
//             must call classifyYjsFrame( so every frame goes through the gate.
// Sockets that accept no client frames at all (pure server push) are listed in
// WS_PUSH_ONLY and fail the check the moment they start reading client frames.
// helpdesk-api's socket is not here: its callers are helpdesk portal customers,
// which the Bam permission catalog does not cover; ticket ownership is its gate.

export const YJS_FRAME_TYPES = ['sync_step1', 'sync_update', 'awareness'];

export const WS_FRAME_MAPS = [
  {
    handler: 'apps/bureau-api/src/routes/ws.routes.ts',
    map: 'apps/bureau-api/src/lib/ws-permissions.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'deniedPermissionForFrame(',
  },
  {
    handler: 'apps/api/src/plugins/websocket.ts',
    map: 'apps/api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'frameGate.check(',
  },
  {
    handler: 'apps/banter-api/src/ws/handler.ts',
    map: 'apps/banter-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/bay-api/src/routes/ws.routes.ts',
    map: 'apps/bay-api/src/routes/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/beacon-api/src/ws/handler.ts',
    map: 'apps/beacon-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
    frames: 'yjs',
  },
  {
    handler: 'apps/bin-api/src/routes/ws.routes.ts',
    map: 'apps/bin-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/blip-api/src/routes/ws.routes.ts',
    map: 'apps/blip-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/bursar-api/src/ws/bursar-ws.ts',
    map: 'apps/bursar-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/blueprint-api/src/routes/ws.routes.ts',
    map: 'apps/blueprint-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/board-api/src/ws/handler.ts',
    map: 'apps/board-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/bond-api/src/routes/ws.routes.ts',
    map: 'apps/bond-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
  },
  {
    handler: 'apps/brief-api/src/ws/handler.ts',
    map: 'apps/brief-api/src/lib/ws-frames.ts',
    exportName: 'WS_FRAME_PERMISSIONS',
    gateCall: 'wsFrameGate.check(',
    frames: 'yjs',
  },
];

/** Sockets that only push to the client; they must never read a client frame. */
export const WS_PUSH_ONLY = [
  'apps/braid-api/src/ws/handler.ts',
  'apps/bulwark-api/src/ws/handler.ts',
  'apps/burn-api/src/ws/burn-ws.ts',
];

const SHADOW_PREFIX = 'shadow:';

export function parseFrameMap(text, exportName) {
  const at = text.indexOf(`${exportName}`);
  if (at < 0) return null;
  const open = text.indexOf('= {', at);
  const close = open < 0 ? -1 : text.indexOf('\n}', open);
  if (open < 0 || close < 0) return null;
  const body = text.slice(open + 3, close);
  const map = new Map();
  for (const m of body.matchAll(/^\s*(?:([a-z_][a-z0-9_]*)|'([a-z0-9_.]+)')\s*:\s*\[([^\]]*)\]/gm)) {
    map.set(m[1] ?? m[2], [...m[3].matchAll(/['"]((?:shadow:)?[a-z0-9_.]+)['"]/g)].map((x) => x[1]));
  }
  return map;
}

/** The frame types a JSON hub's handler dispatches on. */
export function jsonFrameTypes(handler) {
  const found = new Set();
  for (const re of [
    /case\s+'([a-z0-9_.]+)'\s*:/g,
    /\.type\s*===\s*'([a-z0-9_.]+)'/g,
    /type:\s*z\.literal\(\s*'([a-z0-9_.]+)'\s*\)/g,
  ]) {
    for (const x of handler.matchAll(re)) found.add(x[1]);
  }
  return found;
}

export function wsFrameCoverageProblems(root = ROOT, manifest = null, hubs = WS_FRAME_MAPS, pushOnly = WS_PUSH_ONLY) {
  const m = manifest ?? JSON.parse(readFile(join(root, 'docs/permissions-action-manifest.json')));
  const catalog = new Set(m.permissions.map((p) => p.id));
  const problems = [];
  let frames = 0;
  for (const hub of hubs) {
    const handler = readFile(join(root, hub.handler));
    const map = parseFrameMap(readFile(join(root, hub.map)), hub.exportName);
    if (!map) {
      problems.push(`${hub.map}: could not find ${hub.exportName} = { ... }`);
      continue;
    }
    const cases = hub.frames === 'yjs' ? new Set(YJS_FRAME_TYPES) : jsonFrameTypes(handler);
    frames += cases.size;
    for (const c of cases) {
      if (!map.has(c)) problems.push(`${hub.handler}: frame '${c}' has no entry in ${hub.exportName} (${hub.map})`);
    }
    for (const [k, ids] of map) {
      if (!cases.has(k)) problems.push(`${hub.map}: ${hub.exportName} maps '${k}', which ${hub.handler} no longer handles`);
      for (const raw of ids) {
        const id = raw.startsWith(SHADOW_PREFIX) ? raw.slice(SHADOW_PREFIX.length) : raw;
        if (!catalog.has(id)) problems.push(`${hub.map}: frame '${k}' maps to '${id}', which is not in the catalog`);
      }
    }
    if (!handler.includes(hub.gateCall)) {
      problems.push(`${hub.handler}: no longer calls ${hub.gateCall}...), so its frame map is not enforced`);
    }
    if (hub.frames === 'yjs' && !handler.includes('classifyYjsFrame(')) {
      problems.push(`${hub.handler}: no longer classifies frames with classifyYjsFrame(), so the gate does not see them`);
    }
  }
  for (const file of pushOnly) {
    const text = readFile(join(root, file));
    if (/\b(?:socket|ws|connection\.socket)\.on\(\s*'message'/.test(text)) {
      problems.push(`${file}: now reads client frames; give it a WS_FRAME_PERMISSIONS map and the shared gate (issue #177)`);
    }
  }
  return { problems, frames };
}

function checkWsFrameCoverage() {
  const { problems, frames } = wsFrameCoverageProblems();
  if (problems.length > 0) {
    console.error('✗ permission catalog WebSocket frame coverage:');
    for (const p of problems) console.error(`    ${p}`);
    process.exit(1);
  }
  console.log(
    `✓ every WebSocket frame is mapped to catalog actions (${WS_FRAME_MAPS.length} hubs, ${frames} frame types, ${WS_PUSH_ONLY.length} push-only sockets)`,
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/'));
if (isMain) {
  regenerate();
  checkRouteCoverage();
  checkWsFrameCoverage();
  checkDb();
}
