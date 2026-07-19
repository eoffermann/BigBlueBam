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
import { parseToolsFromFile, APP_TOOL_MODULES, TOOLS_DIR } from './lib/tool-source.mjs';

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
 * order. Returns hex string.
 */
function hashSourceTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const hash = createHash('sha256');
  const files = collectFiles(dir, /\.ts$/);
  files.sort();
  for (const f of files) {
    hash.update(fs.readFileSync(f));
  }
  return hash.digest('hex');
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
    const prevPath = path.join(ROOT, 'docs', 'apps', meta.app, 'meta.json');
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

    const metaPath = path.join(appDocsDir, 'meta.json');
    if (!dryRun) {
      ensureDir(appDocsDir);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    }
  }

  const changedPath = path.join(ROOT, 'docs', 'auto', 'changed-apps.json');
  if (!dryRun) {
    ensureDir(path.join(ROOT, 'docs', 'auto'));
    fs.writeFileSync(changedPath, JSON.stringify({ generated_at: new Date().toISOString(), changed: changes }, null, 2) + '\n', 'utf-8');
  }
  console.log(`Change detection: ${changes.length} app(s) changed`);
  for (const c of changes) {
    console.log(`  - ${c.app}: ${c.reason}`);
  }
  console.log('');
  console.log('Stage 3 complete.');
}

main();
