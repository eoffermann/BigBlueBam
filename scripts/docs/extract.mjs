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

const APP_REGISTRY = {
  bam:      { nginxPath: '/b3/',       apiPort: 4000, apiDir: 'api',          toolsFile: null },
  banter:   { nginxPath: '/banter/',   apiPort: 4002, apiDir: 'banter-api',   toolsFile: 'banter-tools' },
  beacon:   { nginxPath: '/beacon/',   apiPort: 4004, apiDir: 'beacon-api',   toolsFile: 'beacon-tools' },
  bearing:  { nginxPath: '/bearing/',  apiPort: 4007, apiDir: 'bearing-api',  toolsFile: 'bearing-tools' },
  bench:    { nginxPath: '/bench/',    apiPort: 4011, apiDir: 'bench-api',    toolsFile: 'bench-tools' },
  bill:     { nginxPath: '/bill/',     apiPort: 4014, apiDir: 'bill-api',     toolsFile: 'bill-tools' },
  blank:    { nginxPath: '/blank/',    apiPort: 4013, apiDir: 'blank-api',    toolsFile: 'blank-tools' },
  blast:    { nginxPath: '/blast/',    apiPort: 4010, apiDir: 'blast-api',    toolsFile: 'blast-tools' },
  blueprint:{ nginxPath: '/blueprint/',apiPort: 4015, apiDir: 'blueprint-api',toolsFile: 'blueprint-tools' },
  board:    { nginxPath: '/board/',    apiPort: 4008, apiDir: 'board-api',    toolsFile: 'board-tools' },
  bolt:     { nginxPath: '/bolt/',     apiPort: 4006, apiDir: 'bolt-api',     toolsFile: 'bolt-tools' },
  bond:     { nginxPath: '/bond/',     apiPort: 4009, apiDir: 'bond-api',     toolsFile: 'bond-tools' },
  book:     { nginxPath: '/book/',     apiPort: 4012, apiDir: 'book-api',     toolsFile: 'book-tools' },
  brief:    { nginxPath: '/brief/',    apiPort: 4005, apiDir: 'brief-api',    toolsFile: 'brief-tools' },
  bureau:   { nginxPath: '/bureau/',   apiPort: 4015, apiDir: 'bureau-api',   toolsFile: 'bureau-tools' },
  helpdesk: { nginxPath: '/helpdesk/', apiPort: 4001, apiDir: 'helpdesk-api', toolsFile: 'helpdesk-tools' },
};

// Additional MCP tool files that are not app-specific (they serve the core
// Bam platform). We group them under "bam".
const BAM_TOOL_FILES = [
  'bam-resolver-tools',
  'comment-tools',
  'import-tools',
  'me-tools',
  'member-tools',
  'platform-tools',
  'project-tools',
  'report-tools',
  'sprint-tools',
  'task-tools',
  'template-tools',
  'user-resolver-tools',
  'utility-tools',
];

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
// MCP tool extraction (regex-based, no TS import required)
// ---------------------------------------------------------------------------

/**
 * Parse a single *-tools.ts file and extract tool registrations.
 *
 * We look for `registerTool(server, {` blocks and extract the `name` and
 * `description` string literals, plus a summary of input parameter names
 * from `z.object({...})` or bare `{...}` shapes.
 */
function extractToolsFromFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const tools = [];

  // Split on registerTool calls
  const chunks = src.split(/registerTool\s*\(\s*server\s*,\s*\{/);
  // First chunk is the preamble, skip it
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Extract name
    const nameMatch = chunk.match(/name:\s*['"`]([^'"`]+)['"`]/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    // Extract description
    const descMatch = chunk.match(/description:\s*['"`]([^'"`]+)['"`]/);
    const description = descMatch ? descMatch[1] : '';

    // Extract input parameter names from the input: { ... } block
    // We find "input:" then collect key names until we hit "returns:" or "handler:"
    const params = extractInputParams(chunk);

    tools.push({ name, description, params });
  }

  return tools;
}

/**
 * Extract input parameter names from a tool registration chunk.
 * Looks for lines like `paramName: z.something()` within the input block.
 */
function extractInputParams(chunk) {
  // Find the input block - starts after "input:" or "input: {"
  const inputStart = chunk.indexOf('input:');
  if (inputStart === -1) return [];

  // Find where the input block ends (at "returns:" or "handler:")
  const afterInput = chunk.slice(inputStart);
  const endIdx = findBlockEnd(afterInput, inputStart);
  const inputBlock = afterInput.slice(0, endIdx);

  // Extract parameter names (identifiers followed by ":")
  // Match lines like: paramName: z.string()...
  const paramRegex = /^\s+(\w+)\s*:/gm;
  const params = [];
  let m;
  while ((m = paramRegex.exec(inputBlock)) !== null) {
    const paramName = m[1];
    // Skip known non-parameter keys
    if (['input', 'returns', 'handler', 'name', 'description'].includes(paramName)) continue;
    params.push(paramName);
  }
  return params;
}

/**
 * Find a reasonable end for the input block by looking for "returns:" or
 * "handler:" at a similar or lower indentation.
 */
function findBlockEnd(text) {
  const returnsIdx = text.search(/\n\s{4}returns:/);
  const handlerIdx = text.search(/\n\s{4}handler:/);
  const candidates = [returnsIdx, handlerIdx].filter((x) => x > 0);
  return candidates.length > 0 ? Math.min(...candidates) : text.length;
}

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

  const toolsDir = path.join(ROOT, 'apps', 'mcp-server', 'src', 'tools');
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
    const toolFilePaths = [];
    if (appName === 'bam') {
      for (const tf of BAM_TOOL_FILES) {
        const fp = path.join(toolsDir, `${tf}.ts`);
        if (fs.existsSync(fp)) toolFilePaths.push(fp);
      }
    } else if (reg.toolsFile) {
      const fp = path.join(toolsDir, `${reg.toolsFile}.ts`);
      if (fs.existsSync(fp)) toolFilePaths.push(fp);
    }

    let allTools = [];
    for (const fp of toolFilePaths) {
      try {
        const tools = extractToolsFromFile(fp);
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
