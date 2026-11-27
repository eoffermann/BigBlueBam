#!/usr/bin/env node

/**
 * Stage 3: Extract
 *
 * Extracts MCP tool catalog and app metadata from the codebase.
 *
 * Usage:
 *   node scripts/docs/extract.mjs [--apps bond,bench] [--dry-run]
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolsFromFile, APP_TOOL_MODULES, TOOLS_DIR, readLaunchpadCatalog } from './lib/tool-source.mjs';
import { appMetaPath } from './lib/app-doc-files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const appsFlag = args.find((a) => a.startsWith('--apps='));
const requestedApps = appsFlag ? appsFlag.split('=')[1].split(',').map((s) => s.trim()) : null;

// ---------------------------------------------------------------------------
// Canonical app registry
// ---------------------------------------------------------------------------
// Maps logical app name to its nginx path, API port, and MCP tool module
// filename (without extension). Apps that share the main api (bam) use the
// "api" directory for their API code.

// The docs-folder name for each app carries the API metadata below. The
// per-app MCP tool-module list (including Bam's multi-module set) is resolved
// from the shared APP_TOOL_MODULES map keyed by Launchpad id (see
// scripts/docs/lib/tool-source.mjs), so extract and the /docs catalog generator
// agree on which tool files back which app.
const APP_REGISTRY = {
  bam:      { nginxPath: '/b3/',       apiPort: 4000, apiDir: 'api',          appId: 'b3' },
  banter:   { nginxPath: '/banter/',   apiPort: 4002, apiDir: 'banter-api',   appId: 'banter' },
  beacon:   { nginxPath: '/beacon/',   apiPort: 4004, apiDir: 'beacon-api',   appId: 'beacon' },
  bearing:  { nginxPath: '/bearing/',  apiPort: 4007, apiDir: 'bearing-api',  appId: 'bearing' },
  bench:    { nginxPath: '/bench/',    apiPort: 4011, apiDir: 'bench-api',    appId: 'bench' },
  bill:     { nginxPath: '/bill/',     apiPort: 4014, apiDir: 'bill-api',     appId: 'bill' },
  blank:    { nginxPath: '/blank/',    apiPort: 4013, apiDir: 'blank-api',    appId: 'blank' },
  blast:    { nginxPath: '/blast/',    apiPort: 4010, apiDir: 'blast-api',    appId: 'blast' },
  blueprint:{ nginxPath: '/blueprint/',apiPort: 4015, apiDir: 'blueprint-api',appId: 'blueprint' },
  board:    { nginxPath: '/board/',    apiPort: 4008, apiDir: 'board-api',    appId: 'board' },
  bolt:     { nginxPath: '/bolt/',     apiPort: 4006, apiDir: 'bolt-api',     appId: 'bolt' },
  bond:     { nginxPath: '/bond/',     apiPort: 4009, apiDir: 'bond-api',     appId: 'bond' },
  book:     { nginxPath: '/book/',     apiPort: 4012, apiDir: 'book-api',     appId: 'book' },
  brief:    { nginxPath: '/brief/',    apiPort: 4005, apiDir: 'brief-api',    appId: 'brief' },
  bureau:   { nginxPath: '/bureau/',   apiPort: 4015, apiDir: 'bureau-api',   appId: 'bureau' },
  bin:      { nginxPath: '/bin/',      apiPort: 4016, apiDir: 'bin-api',      appId: 'bin' },
  bay:      { nginxPath: '/bay/',      apiPort: 4017, apiDir: 'bay-api',      appId: 'bay' },
  blip:     { nginxPath: '/blip/',     apiPort: 4018, apiDir: 'blip-api',     appId: 'blip' },
  basis:    { nginxPath: '/basis/',    apiPort: 4019, apiDir: 'basis-api',    appId: 'basis' },
  braid:    { nginxPath: '/braid/',    apiPort: 4020, apiDir: 'braid-api',    appId: 'braid' },
  bulwark:  { nginxPath: '/bulwark/',  apiPort: 4021, apiDir: 'bulwark-api',  appId: 'bulwark' },
  burn:     { nginxPath: '/burn/',     apiPort: 4022, apiDir: 'burn-api',     appId: 'burn' },
  bursar:   { nginxPath: '/bursar/',   apiPort: 4023, apiDir: 'bursar-api',   appId: 'bursar' },
  bastion:  { nginxPath: '/bastion/',  apiPort: 4024, apiDir: 'bastion-api',  appId: 'bastion' },
  helpdesk: { nginxPath: '/helpdesk/', apiPort: 4001, apiDir: 'helpdesk-api', appId: 'helpdesk' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  if (!dryRun) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Compute SHA-256 of all *.ts files under a directory, concatenated in sorted
 * order. Returns hex string. Platform-independent (#398): files are ordered by
 * their POSIX path relative to `dir` and hashed with CRLF folded to LF, so a
 * Windows autocrlf checkout and a Linux CI checkout of the same commit agree
 * and docs:generate does not rewrite every meta.json when the platform changes.
 */
function hashSourceTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const hash = createHash('sha256');
  const files = collectFiles(dir, /\.ts$/)
    .map((f) => ({ f, key: path.relative(dir, f).split(path.sep).join('/') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { f } of files) {
    hash.update(fs.readFileSync(f, 'utf-8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

/**
 * Keep the previous `generated_at` when nothing else in the JSON changed, so a
 * rerun on unchanged sources leaves the file byte-identical (#398).
 */
function withStableTimestamp(next, prevPath) {
  try {
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));
    const strip = ({ generated_at: _ignored, ...rest }) => JSON.stringify(rest);
    if (prev.generated_at && strip(prev) === strip(next)) return { ...next, generated_at: prev.generated_at };
  } catch {
    // No previous file (or unreadable): keep the fresh timestamp.
  }
  return next;
}

function collectFiles(dir, pattern) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function countFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return 0;
  return collectFiles(dir, pattern).length;
}

// ---------------------------------------------------------------------------
// MCP tool extraction
// ---------------------------------------------------------------------------
// The registerTool(...) parser and the app -> tool-module mapping live in the
// shared scripts/docs/lib/tool-source.mjs so this stage and the /docs catalog
// generator never diverge. `parseToolsFromFile` is imported at the top.

// ---------------------------------------------------------------------------
// Write MCP tools markdown
// ---------------------------------------------------------------------------

function writeToolsMarkdown(appName, tools, outDir) {
  if (tools.length === 0) {
    const content = `# ${appName} MCP Tools\n\n_No MCP tools registered for this app._\n`;
    const outPath = path.join(outDir, 'mcp-tools.md');
    if (!dryRun) {
      ensureDir(outDir);
      fs.writeFileSync(outPath, content, 'utf-8');
    }
    console.log(`  mcp-tools.md: 0 tools`);
    return;
  }

  // Sort by name
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const lines = [`# ${appName} MCP Tools\n`, ''];
  lines.push(`| Tool | Description | Parameters |`);
  lines.push(`|------|-------------|------------|`);
  for (const t of tools) {
    const paramStr = t.params.length > 0 ? '`' + t.params.join('`, `') + '`' : 'none';
    // Escape pipes in description
    const desc = t.description.replace(/\|/g, '\\|');
    lines.push(`| \`${t.name}\` | ${desc} | ${paramStr} |`);
  }
  lines.push('');

  const content = lines.join('\n');
  const outPath = path.join(outDir, 'mcp-tools.md');
  if (!dryRun) {
    ensureDir(outDir);
    fs.writeFileSync(outPath, content, 'utf-8');
  }
  console.log(`  mcp-tools.md: ${tools.length} tools`);
}

// ---------------------------------------------------------------------------
// App metadata
// ---------------------------------------------------------------------------

function buildAppMetadata(appName, reg) {
  const apiSrcDir = path.join(ROOT, 'apps', reg.apiDir, 'src');
  const routesDir = path.join(apiSrcDir, 'routes');
  const schemaDir = path.join(apiSrcDir, 'db', 'schema');
  const frontendDir = path.join(ROOT, 'apps', appName);

  // Count route files
  const routeFiles = countFiles(routesDir, /\.ts$/);

  // Count schema modules
  const schemaModules = countFiles(schemaDir, /\.ts$/);

  // Detect seeder presence
  const seederPatterns = [
    `seed-${appName}.sql`,
    `seed-${appName}.mjs`,
    `seed-${appName}.js`,
  ];
  const hasSeeder = seederPatterns.some((p) =>
    fs.existsSync(path.join(ROOT, 'scripts', p)),
  );

  // Compute source hash for the API src tree
  const srcHash = hashSourceTree(apiSrcDir);

  // Check if frontend exists
  const hasFrontend = fs.existsSync(frontendDir) && fs.existsSync(path.join(frontendDir, 'package.json'));

  return {
    app: appName,
    nginx_path: reg.nginxPath,
    api_port: reg.apiPort,
    api_dir: reg.apiDir,
    route_files: routeFiles,
    schema_modules: schemaModules,
    has_seeder: hasSeeder,
    has_frontend: hasFrontend,
    src_hash: srcHash,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

function detectChanges(allMeta) {
  const changed = [];
  for (const meta of allMeta) {
    const prevPath = appMetaPath(ROOT, meta.app);
    if (!fs.existsSync(prevPath)) {
      changed.push({ app: meta.app, reason: 'new' });
      continue;
    }
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf-8'));
      if (prev.src_hash !== meta.src_hash) {
        changed.push({ app: meta.app, reason: 'src_hash_changed', prev_hash: prev.src_hash, new_hash: meta.src_hash });
      }
    } catch {
      changed.push({ app: meta.app, reason: 'meta_parse_error' });
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('Stage 3: Extract');
  console.log(`  Root: ${ROOT}`);
  if (dryRun) console.log('  (dry-run mode)');
  console.log('');

  // The Launchpad roster is the fact; APP_REGISTRY only adds API metadata to
  // it. A Launchpad app missing here would get no mcp-tools.md or meta.json,
  // silently (Bastion and Bursar shipped that way, #395), so refuse to run.
  const registeredIds = new Set(Object.values(APP_REGISTRY).map((r) => r.appId));
  const unregistered = readLaunchpadCatalog()
    .map((e) => e.id)
    .filter((id) => !registeredIds.has(id));
  if (unregistered.length > 0) {
    console.error(
      `ERROR: Launchpad app(s) missing from APP_REGISTRY in scripts/docs/extract.mjs: ${unregistered.join(', ')}.\n` +
        '  Add an entry (nginx path, API port, API dir) for each so its MCP tool reference is generated.',
    );
    process.exit(1);
  }

  const toolsDir = TOOLS_DIR;
  const allMeta = [];

  // Determine which apps to process
  const appsToProcess = requestedApps
    ? Object.entries(APP_REGISTRY).filter(([name]) => requestedApps.includes(name))
    : Object.entries(APP_REGISTRY);

  // Phase 1: Build metadata and extract tools (before writing, so change
  // detection can compare against the previous on-disk meta.json).
  const appResults = [];
  for (const [appName, reg] of appsToProcess) {
    console.log(`[${appName}]`);

    const appDocsDir = path.join(ROOT, 'docs', 'apps', appName);

    // --- MCP tools ---
    // Resolve tool modules via the shared APP_TOOL_MODULES map (keyed by
    // Launchpad id; Bam's id is `b3`).
    const modules = APP_TOOL_MODULES[reg.appId] || [];
    const toolFilePaths = modules
      .map((m) => path.join(toolsDir, `${m}.ts`))
      .filter((fp) => fs.existsSync(fp));

    let allTools = [];
    for (const fp of toolFilePaths) {
      try {
        const tools = parseToolsFromFile(fp);
        allTools.push(...tools);
      } catch (err) {
        console.error(`  WARNING: Failed to parse ${path.basename(fp)}: ${err.message}`);
        allTools.push({ name: `_parse_error_${path.basename(fp)}`, description: `Parse error: ${err.message}`, params: [] });
      }
    }

    const meta = buildAppMetadata(appName, reg);
    meta.mcp_tool_count = allTools.length;
    allMeta.push(meta);

    appResults.push({ appName, appDocsDir, allTools, meta });
    console.log(`  ${allTools.length} MCP tools, ${meta.route_files} routes, ${meta.schema_modules} schemas`);
    console.log('');
  }

  // Phase 2: Change detection (compare against previous meta.json on disk).
  const changes = detectChanges(allMeta);

  // Phase 3: Write outputs.
  for (const { appName, appDocsDir, allTools, meta } of appResults) {
    writeToolsMarkdown(appName, allTools, appDocsDir);

    // extract.mjs is the only writer of meta.json (#400, lib/app-doc-files.mjs).
    const metaPath = appMetaPath(ROOT, appName);
    if (!dryRun) {
      ensureDir(appDocsDir);
      fs.writeFileSync(metaPath, JSON.stringify(withStableTimestamp(meta, metaPath), null, 2) + '\n', 'utf-8');
    }
  }

  // changed-apps.json records the most recent extract that saw a source change.
  // A run that detects no change leaves it as is (rewriting it with an empty
  // list would make every rerun of docs:generate dirty the tree).
  const changedPath = path.join(ROOT, 'docs', 'auto', 'changed-apps.json');
  if (!dryRun && changes.length > 0) {
    ensureDir(path.join(ROOT, 'docs', 'auto'));
    const next = withStableTimestamp({ generated_at: new Date().toISOString(), changed: changes }, changedPath);
    fs.writeFileSync(changedPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  }
  console.log(`Change detection: ${changes.length} app(s) changed`);
  for (const c of changes) {
    console.log(`  - ${c.app}: ${c.reason}`);
  }
  console.log('');
  console.log('Stage 3 complete.');
}

main();
