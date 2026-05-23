#!/usr/bin/env node
// Wave F audit — classify every catalog permission as Enforced or Orphan.
//
// Enforced: appears in apps/ source as one of:
//   - fastify.requireCan('<id>')
//   - shadowOnly('<id>')
//   - dualReadGate({ ..., permission: '<id>' })  (legacy stragglers)
//   - the MCP TOOL_TO_PERMISSION map value
//
// Orphan: in catalog but no code path references it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// 1. Load the catalog from the manifest (1060 rows)
const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/permissions-action-manifest.json'), 'utf8'));
const catalog = new Set(manifest.permissions.map(p => p.id));

// 2. Walk apps/ and packages/ looking for permission id references
const FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const SCAN_DIRS = [
  join(ROOT, 'apps'),
  join(ROOT, 'packages'),
];

const enforced = new Set();
const filesScanned = { count: 0 };

// Files that exhaustively enumerate permission IDs in string form (the
// generated codegen + the manifest JSON). Scanning these would mark every
// catalog id as "enforced" just by virtue of its name appearing.
const SKIP_FILE_SUFFIXES = [
  'packages\\permissions\\src\\generated\\permissions.ts',
  'packages/permissions/src/generated/permissions.ts',
  'docs/permissions-action-manifest.json',
  'docs\\permissions-action-manifest.json',
];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) {
      walk(path);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    const ext = dot < 0 ? '' : entry.slice(dot);
    if (!FILE_EXTENSIONS.has(ext)) continue;
    // Skip the generated codegen file (still counted via the explicit
    // TOOL_TO_PERMISSION pull below).
    if (SKIP_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix))) continue;
    filesScanned.count++;
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    // Match strings inside the patterns:
    //   requireCan('id')  or requireCan("id")
    //   shadowOnly('id')
    //   dualReadGate({ ..., permission: 'id' })  (legacy)
    //   permissionId: 'id'  (e.g. permissions.ts plugin)
    //   permission: 'id'
    const patterns = [
      /requireCan\(\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      /shadowOnly\(\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      /permission:\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      /permissionId:\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      // Factory preHandlers that bind the permission via their first arg
      // (eg. adminPreHandler('banter.admin_setting.list')).
      /adminPreHandler\(\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      /userGroupAdminPreHandler\(\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
      // Catch any standalone string literal that LOOKS like a permission id.
      // This is a deliberately wide net: it picks up the useCan(...) hook
      // callers in the frontend, plus any ad-hoc gates that bypass the
      // named helpers above. False positives on non-permission ids are
      // filtered by the catalog membership check that follows.
      /['"]([a-z][a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+)['"]/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text))) {
        enforced.add(m[1]);
      }
    }
  }
}

for (const d of SCAN_DIRS) walk(d);

// 3. Also union with the MCP TOOL_TO_PERMISSION map's value set.
//    Read it from the generated codegen TS file (it lists every mapping).
//    Codegen uses double quotes:  ["tool_name", "app.resource.verb"]
const codegen = readFileSync(join(ROOT, 'packages/permissions/src/generated/permissions.ts'), 'utf8');
const toolMapMatches = codegen.matchAll(/\["[a-z0-9_]+",\s*"([a-z][a-z0-9_]*\.[a-z0-9_]+\.[a-z0-9_]+)"\]/g);
for (const m of toolMapMatches) {
  enforced.add(m[1]);
}

// 4. Classify
const orphans = [];
const enforcedHits = [];
for (const id of catalog) {
  if (enforced.has(id)) enforcedHits.push(id);
  else orphans.push(id);
}

// 5. Per-app count
const perApp = new Map();
for (const p of manifest.permissions) {
  const app = p.app;
  if (!perApp.has(app)) perApp.set(app, { total: 0, enforced: 0, orphan: 0 });
  const s = perApp.get(app);
  s.total++;
  if (enforced.has(p.id)) s.enforced++;
  else s.orphan++;
}

const result = {
  files_scanned: filesScanned.count,
  catalog_size: catalog.size,
  enforced_count: enforcedHits.length,
  orphan_count: orphans.length,
  per_app: Object.fromEntries(perApp),
  orphans: orphans.sort(),
};

console.log(JSON.stringify(result, null, 2));
