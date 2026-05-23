#!/usr/bin/env node

/**
 * Stage 5: Publish
 *
 * Rewrites README.md marker regions, syncs marketing content to site/,
 * and writes the global manifest and regen log.
 *
 * Usage:
 *   node scripts/docs/publish.mjs [--apps bond,bench] [--dry-run] [--init]
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
const initMode = args.includes('--init');
const appsFlag = args.find((a) => a.startsWith('--apps='));
const requestedApps = appsFlag ? appsFlag.split('=')[1].split(',').map((s) => s.trim()) : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  if (!dryRun) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readFileOr(filePath, fallback) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function displayName(appName) {
  const overrides = {
    bam: 'Bam (Project Management)',
    banter: 'Banter (Team Messaging)',
    beacon: 'Beacon (Knowledge Base)',
    bearing: 'Bearing (Goals & OKRs)',
    bench: 'Bench (Analytics)',
    bill: 'Bill (Invoicing)',
    blank: 'Blank (Forms)',
    blast: 'Blast (Email Campaigns)',
    board: 'Board (Visual Collaboration)',
    bolt: 'Bolt (Workflow Automation)',
    bond: 'Bond (CRM)',
    book: 'Book (Scheduling)',
    brief: 'Brief (Documents)',
    helpdesk: 'Helpdesk (Support Portal)',
  };
  return overrides[appName] || capitalize(appName);
}

// ---------------------------------------------------------------------------
// README marker management
// ---------------------------------------------------------------------------

const APP_SECTIONS_START = '<!-- AUTODOCS:APP_SECTIONS:START -->';
const APP_SECTIONS_END = '<!-- AUTODOCS:APP_SECTIONS:END -->';
const DOCS_INDEX_START = '<!-- AUTODOCS:DOCS_INDEX:START -->';
const DOCS_INDEX_END = '<!-- AUTODOCS:DOCS_INDEX:END -->';

/**
 * Replace content between start and end markers in a string.
 * If markers do not exist, returns null (caller decides whether to inject).
 */
function replaceBetweenMarkers(text, startMarker, endMarker, newContent) {
  const startIdx = text.indexOf(startMarker);
  const endIdx = text.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return null;

  const before = text.slice(0, startIdx + startMarker.length);
  const after = text.slice(endIdx);
  return before + '\n' + newContent + '\n' + after;
}

/**
 * Inject markers around an approximate line range. Used on first run with --init.
 * Finds the target section and wraps it.
 */
function injectAppSectionsMarkers(readme) {
  // Look for the first app section after line ~390 (## Banter or similar)
  // and end before ## AI Provider Configuration or similar around line ~825.
  // We insert markers around the "## Banter" through the Bond MCP table area.
  const lines = readme.split('\n');

  // Find first app-level heading after the API Keys section
  let startLine = -1;
  let endLine = -1;

  for (let i = 380; i < lines.length; i++) {
    if (startLine === -1 && /^## (Banter|Beacon|Bearing|Bench|Bill|Blank|Blast|Board|Bolt|Bond|Book|Brief)/.test(lines[i])) {
      startLine = i;
    }
    if (startLine !== -1 && /^## AI Provider Configuration/.test(lines[i])) {
      // End marker goes before the --- separator above this heading
      endLine = i;
      // Walk back past blank lines and ---
      while (endLine > startLine && (lines[endLine - 1].trim() === '' || lines[endLine - 1].trim() === '---')) {
        endLine--;
      }
      endLine++; // Include the last content line
      break;
    }
  }

  if (startLine === -1 || endLine === -1) {
    console.log('  WARNING: Could not find app sections region in README. Markers not injected.');
    return readme;
  }

  lines.splice(endLine, 0, '', APP_SECTIONS_END);
  lines.splice(startLine, 0, APP_SECTIONS_START, '');
  return lines.join('\n');
}

function injectDocsIndexMarkers(readme) {
  const lines = readme.split('\n');

  let startLine = -1;
  let endLine = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## Documentation')) {
      // The table starts after the heading
      startLine = i + 1;
    }
    if (startLine !== -1 && i > startLine && /^## /.test(lines[i])) {
      endLine = i;
      while (endLine > startLine && (lines[endLine - 1].trim() === '' || lines[endLine - 1].trim() === '---')) {
        endLine--;
      }
      endLine++;
      break;
    }
  }

  if (startLine === -1) {
    console.log('  WARNING: Could not find Documentation section in README. Markers not injected.');
    return readme;
  }
  if (endLine === -1) {
    // Documentation is the last section
    endLine = lines.length;
    while (endLine > startLine && (lines[endLine - 1].trim() === '' || lines[endLine - 1].trim() === '---')) {
      endLine--;
    }
    endLine++;
  }

  lines.splice(endLine, 0, '', DOCS_INDEX_END);
  lines.splice(startLine, 0, DOCS_INDEX_START, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generate per-app card for README
// ---------------------------------------------------------------------------

function generateAppCard(appName, meta) {
  const name = displayName(appName);
  const description = meta.mcp_tool_count > 0
    ? `${meta.route_files} routes, ${meta.schema_modules} schemas, ${meta.mcp_tool_count} MCP tools`
    : `${meta.route_files} routes, ${meta.schema_modules} schemas`;

  // Check for hero screenshot
  const heroPath = path.join(ROOT, 'docs', 'apps', appName, 'screenshots', 'light');
  let heroImg = '';
  if (fs.existsSync(heroPath)) {
    const pngs = fs.readdirSync(heroPath).filter((f) => f.endsWith('.png')).sort();
    if (pngs.length > 0) {
      heroImg = `\n\n<img src="docs/apps/${appName}/screenshots/light/${pngs[0]}" width="400" alt="${name}">`;
    }
  }

  const guideLink = `[Guide](docs/apps/${appName}/guide.md)`;
  const marketingLink = `[Overview](docs/apps/${appName}/marketing.md)`;
  const toolsLink = meta.mcp_tool_count > 0 ? ` | [MCP Tools](docs/apps/${appName}/mcp-tools.md)` : '';

  return [
    `### ${name}`,
    '',
    `${description}${heroImg}`,
    '',
    `${guideLink} | ${marketingLink}${toolsLink}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Generate docs index for README
// ---------------------------------------------------------------------------

function generateDocsIndex(appNames) {
  const lines = [
    '',
    '| Document | Description |',
    '|----------|-------------|',
    '| [Getting Started](docs/guides/getting-started.md) | Setup, first run, troubleshooting |',
    '| [Deployment](docs/guides/deployment.md) | Quickstart wizard, tiers, scaling, Docker Compose + Railway |',
    '| [Operations](docs/guides/operations.md) | Updates, backups, maintenance, troubleshooting |',
    '| [Development](docs/guides/development.md) | Contributing, testing, code style, monorepo workflow |',
    '| [Architecture](docs/reference/architecture.md) | System design, data flow, components |',
    '| [Database](docs/reference/database.md) | ER diagrams, table descriptions, indexing |',
    '| [API Reference](docs/reference/api-reference.md) | All REST endpoints with examples |',
    '| [MCP Server](docs/reference/mcp-server.md) | Tools, resources, prompts, configuration |',
    '| [Permissions](docs/reference/permissions.md) | Permission model, roles, scoping |',
    '| [Agent Conventions](docs/reference/agent-conventions.md) | Rules agents must follow (visibility preflight, audit) |',
  ];

  // Add per-app guide links
  lines.push('| | |');
  lines.push('| **Per-App Guides** | |');
  for (const app of appNames) {
    lines.push(`| [${displayName(app)} Guide](docs/apps/${app}/guide.md) | User guide and MCP tool reference |`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// README rewrite
// ---------------------------------------------------------------------------

function rewriteReadme(appMetas) {
  const readmePath = path.join(ROOT, 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf-8');
  const appNames = Object.keys(appMetas).sort();

  // Check for markers. If missing and --init, inject them.
  let hasAppMarkers = readme.includes(APP_SECTIONS_START) && readme.includes(APP_SECTIONS_END);
  let hasDocsMarkers = readme.includes(DOCS_INDEX_START) && readme.includes(DOCS_INDEX_END);

  if (!hasAppMarkers) {
    if (initMode) {
      console.log('  Injecting APP_SECTIONS markers into README.md');
      readme = injectAppSectionsMarkers(readme);
      hasAppMarkers = readme.includes(APP_SECTIONS_START);
    } else {
      console.log('  WARNING: APP_SECTIONS markers not found in README.md. Run with --init to inject them.');
    }
  }

  if (!hasDocsMarkers) {
    if (initMode) {
      console.log('  Injecting DOCS_INDEX markers into README.md');
      readme = injectDocsIndexMarkers(readme);
      hasDocsMarkers = readme.includes(DOCS_INDEX_START);
    } else {
      console.log('  WARNING: DOCS_INDEX markers not found in README.md. Run with --init to inject them.');
    }
  }

  // Generate app sections content
  if (hasAppMarkers) {
    const cards = appNames.map((app) => generateAppCard(app, appMetas[app])).join('\n\n');
    const result = replaceBetweenMarkers(readme, APP_SECTIONS_START, APP_SECTIONS_END, cards);
    if (result) {
      readme = result;
      console.log(`  Rewrote APP_SECTIONS with ${appNames.length} app cards`);
    }
  }

  // Generate docs index content
  if (hasDocsMarkers) {
    const docsContent = generateDocsIndex(appNames);
    const result = replaceBetweenMarkers(readme, DOCS_INDEX_START, DOCS_INDEX_END, docsContent);
    if (result) {
      readme = result;
      console.log(`  Rewrote DOCS_INDEX with ${appNames.length} per-app guide links`);
    }
  }

  if (!dryRun) {
    fs.writeFileSync(readmePath, readme, 'utf-8');
  } else {
    console.log('  [dry-run] README.md not written');
  }
}

// ---------------------------------------------------------------------------
// Marketing site sync
// ---------------------------------------------------------------------------

function syncMarketingSite(appMetas) {
  const contentDir = path.join(ROOT, 'site', 'src', 'content', 'apps');
  const screenshotsDir = path.join(ROOT, 'site', 'public', 'screenshots');

  for (const [appName, meta] of Object.entries(appMetas)) {
    const srcMarketing = path.join(ROOT, 'docs', 'apps', appName, 'marketing.md');
    if (!fs.existsSync(srcMarketing)) continue;

    // Copy marketing.md
    const destMarketing = path.join(contentDir, `${appName}.md`);
    if (!dryRun) {
      ensureDir(contentDir);
      fs.copyFileSync(srcMarketing, destMarketing);
    }

    // Copy screenshots directory
    const srcScreenshots = path.join(ROOT, 'docs', 'apps', appName, 'screenshots');
    if (fs.existsSync(srcScreenshots)) {
      const destScreenshotsApp = path.join(screenshotsDir, appName);
      if (!dryRun) {
        copyDirRecursive(srcScreenshots, destScreenshotsApp);
      }
    }
  }
  console.log(`  Synced marketing content to site/`);
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshot manifest
// ---------------------------------------------------------------------------

function buildScreenshotManifest(appNames) {
  const manifest = { generated_at: new Date().toISOString(), screenshots: [] };

  for (const appName of appNames) {
    for (const theme of ['light', 'dark']) {
      const dir = path.join(ROOT, 'docs', 'apps', appName, 'screenshots', theme);
      if (!fs.existsSync(dir)) continue;
      const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      for (const png of pngs) {
        const fullPath = path.join(dir, png);
        const stat = fs.statSync(fullPath);
        const hash = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
        manifest.screenshots.push({
          app: appName,
          theme,
          file: png,
          path: `docs/apps/${appName}/screenshots/${theme}/${png}`,
          size: stat.size,
          hash,
        });
      }
    }
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Regen log
// ---------------------------------------------------------------------------

function appendRegenLog(appNames, startTime) {
  const logPath = path.join(ROOT, 'docs', 'auto', 'regen-log.md');
  const existing = readFileOr(logPath, '# Documentation Regeneration Log\n');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const timestamp = new Date().toISOString();

  const entry = [
    '',
    `## ${timestamp}`,
    '',
    `- **Stage:** publish`,
    `- **Apps:** ${appNames.join(', ')}`,
    `- **Duration:** ${duration}s`,
    `- **Mode:** ${dryRun ? 'dry-run' : 'live'}`,
    '',
  ].join('\n');

  if (!dryRun) {
    ensureDir(path.join(ROOT, 'docs', 'auto'));
    fs.writeFileSync(logPath, existing + entry, 'utf-8');
  }
  console.log(`  Appended regen log entry`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const startTime = Date.now();
  console.log('Stage 5: Publish');
  if (dryRun) console.log('  (dry-run mode)');
  console.log('');

  // Discover all apps with meta.json
  const appsDir = path.join(ROOT, 'docs', 'apps');
  if (!fs.existsSync(appsDir)) {
    console.error('ERROR: docs/apps/ does not exist. Run extract + compose stages first.');
    process.exit(1);
  }

  const allAppDirs = fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(appsDir, name, 'meta.json')));

  const appNames = requestedApps
    ? allAppDirs.filter((name) => requestedApps.includes(name))
    : allAppDirs;

  // Load all app metadata
  const appMetas = {};
  for (const name of appNames) {
    try {
      appMetas[name] = JSON.parse(fs.readFileSync(path.join(appsDir, name, 'meta.json'), 'utf-8'));
    } catch (err) {
      console.error(`  WARNING: Could not read meta.json for ${name}: ${err.message}`);
    }
  }

  // 1. README rewrite
  console.log('[README rewrite]');
  rewriteReadme(appMetas);
  console.log('');

  // 2. Marketing site sync
  console.log('[Marketing site sync]');
  syncMarketingSite(appMetas);
  console.log('');

  // 3. Screenshot manifest
  console.log('[Screenshot manifest]');
  const manifest = buildScreenshotManifest(appNames);
  const manifestPath = path.join(ROOT, 'docs', 'auto', 'screenshot-manifest.json');
  if (!dryRun) {
    ensureDir(path.join(ROOT, 'docs', 'auto'));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }
  console.log(`  ${manifest.screenshots.length} screenshots indexed`);
  console.log('');

  // 4. Regen log
  console.log('[Regen log]');
  appendRegenLog(appNames, startTime);
  console.log('');

  console.log('Stage 5 complete.');
}

main();
