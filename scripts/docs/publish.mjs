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
// --check regenerates the README AUTODOCS regions in memory and exits non-zero
// if they differ from what is committed. It performs NO writes and NO side
// effects (no marketing sync, no screenshot manifest, no regen log), mirroring
// build-docs-catalog.mjs --check. It implies README-only.
const checkMode = args.includes('--check');
// --readme-only rewrites just the README AUTODOCS regions and skips the
// marketing-site sync, screenshot manifest, and regen log side effects.
const readmeOnly = checkMode || args.includes('--readme-only');
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
    introduction: 'Introduction to BigBlueBam',
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

/**
 * Read an app's help.md for its card heading and description sentence.
 * Returns { heading, description } where:
 *   - heading is the H1 content ("# Name - Subtitle" -> "Name - Subtitle"),
 *   - description is the first blockquote paragraph (contiguous "> " lines
 *     joined into one sentence), or null if there is no blockquote.
 * Returns null entirely if the file does not exist.
 */
function readHelpMeta(appName) {
  const helpPath = path.join(ROOT, 'docs', 'apps', appName, 'help.md');
  if (!fs.existsSync(helpPath)) return null;
  const lines = fs.readFileSync(helpPath, 'utf-8').split('\n');

  let heading = null;
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      heading = m[1].trim();
      break;
    }
  }

  // First contiguous blockquote block after the H1.
  let description = null;
  const quoteParts = [];
  let inQuote = false;
  for (const line of lines) {
    const isQuote = /^\s*>/.test(line);
    if (isQuote) {
      inQuote = true;
      quoteParts.push(line.replace(/^\s*>\s?/, '').trim());
    } else if (inQuote) {
      break; // end of the first blockquote paragraph
    }
  }
  const joined = quoteParts.join(' ').replace(/\s+/g, ' ').trim();
  if (joined) description = joined;

  return { heading, description };
}

/** Build the conditional link row for an app card (only existing files). */
function appLinkRow(appName) {
  const appDir = path.join(ROOT, 'docs', 'apps', appName);
  const links = [];
  if (fs.existsSync(path.join(appDir, 'help.md'))) {
    links.push(`[Help](docs/apps/${appName}/help.md)`);
  }
  if (fs.existsSync(path.join(appDir, 'guide.md'))) {
    links.push(`[Guide](docs/apps/${appName}/guide.md)`);
  }
  if (fs.existsSync(path.join(appDir, 'marketing.md'))) {
    links.push(`[Overview](docs/apps/${appName}/marketing.md)`);
  }
  if (fs.existsSync(path.join(appDir, 'mcp-tools.md'))) {
    links.push(`[MCP Tools](docs/apps/${appName}/mcp-tools.md)`);
  }
  return links.join(' | ');
}

function generateAppCard(appName, meta, productCount) {
  const help = readHelpMeta(appName);

  // The suite introduction is not a product app: it has no routes or schemas,
  // so give it a suite-level card with the live app count instead of a
  // "0 routes, 0 schemas" line.
  if (appName === 'introduction') {
    return [
      `### ${displayName(appName)}`,
      '',
      `An overview of the whole suite: the ${productCount} apps, how they connect, and how AI agents work alongside your team.`,
      '',
      appLinkRow(appName),
    ].join('\n');
  }

  // Heading: prefer the help.md H1 ("Name - Subtitle"); fall back to the
  // hand-curated display name.
  const heading = help && help.heading ? help.heading : displayName(appName);

  // Counts line kept as a secondary detail.
  const counts = meta.mcp_tool_count > 0
    ? `${meta.route_files} routes, ${meta.schema_modules} schemas, ${meta.mcp_tool_count} MCP tools`
    : `${meta.route_files} routes, ${meta.schema_modules} schemas`;

  // Description sentence: prefer the help.md blockquote; otherwise the counts
  // line stands alone (old behavior).
  const description = help && help.description ? help.description : counts;

  // Hero screenshot: prefer docs/apps/<app>/screenshots/light/<first>.png.
  const heroDir = path.join(ROOT, 'docs', 'apps', appName, 'screenshots', 'light');
  let heroImg = '';
  if (fs.existsSync(heroDir)) {
    const pngs = fs.readdirSync(heroDir).filter((f) => f.endsWith('.png')).sort();
    if (pngs.length > 0) {
      heroImg = `<img src="docs/apps/${appName}/screenshots/light/${pngs[0]}" width="400" alt="${heading}">`;
    }
  }

  const parts = [`### ${heading}`, '', description];
  // Only repeat the counts line when the description came from help.md.
  if (help && help.description) {
    parts.push('', counts);
  }
  if (heroImg) {
    parts.push('', heroImg);
  }
  parts.push('', appLinkRow(appName));
  return parts.join('\n');
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

/**
 * Compute the rewritten README content in memory (no writes). Returns the new
 * README string with both AUTODOCS regions replaced. `logging` controls whether
 * progress lines are printed (suppressed in --check to keep output clean).
 */
function computeReadme(appMetas, { logging = true } = {}) {
  const readmePath = path.join(ROOT, 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf-8');
  const appNames = Object.keys(appMetas).sort();
  // Product apps exclude the suite "introduction" pseudo-app.
  const productCount = appNames.filter((a) => a !== 'introduction').length;
  const log = (msg) => { if (logging) console.log(msg); };

  // Check for markers. If missing and --init, inject them.
  let hasAppMarkers = readme.includes(APP_SECTIONS_START) && readme.includes(APP_SECTIONS_END);
  let hasDocsMarkers = readme.includes(DOCS_INDEX_START) && readme.includes(DOCS_INDEX_END);

  if (!hasAppMarkers) {
    if (initMode) {
      log('  Injecting APP_SECTIONS markers into README.md');
      readme = injectAppSectionsMarkers(readme);
      hasAppMarkers = readme.includes(APP_SECTIONS_START);
    } else {
      log('  WARNING: APP_SECTIONS markers not found in README.md. Run with --init to inject them.');
    }
  }

  if (!hasDocsMarkers) {
    if (initMode) {
      log('  Injecting DOCS_INDEX markers into README.md');
      readme = injectDocsIndexMarkers(readme);
      hasDocsMarkers = readme.includes(DOCS_INDEX_START);
    } else {
      log('  WARNING: DOCS_INDEX markers not found in README.md. Run with --init to inject them.');
    }
  }

  // Generate app sections content
  if (hasAppMarkers) {
    const cards = appNames.map((app) => generateAppCard(app, appMetas[app], productCount)).join('\n\n');
    const result = replaceBetweenMarkers(readme, APP_SECTIONS_START, APP_SECTIONS_END, cards);
    if (result) {
      readme = result;
      log(`  Rewrote APP_SECTIONS with ${appNames.length} app cards`);
    }
  }

  // Generate docs index content
  if (hasDocsMarkers) {
    const docsContent = generateDocsIndex(appNames);
    const result = replaceBetweenMarkers(readme, DOCS_INDEX_START, DOCS_INDEX_END, docsContent);
    if (result) {
      readme = result;
      log(`  Rewrote DOCS_INDEX with ${appNames.length} per-app guide links`);
    }
  }

  return readme;
}

function rewriteReadme(appMetas) {
  const readmePath = path.join(ROOT, 'README.md');
  const readme = computeReadme(appMetas);

  if (!dryRun) {
    fs.writeFileSync(readmePath, readme, 'utf-8');
  } else {
    console.log('  [dry-run] README.md not written');
  }
}

/**
 * --check: regenerate the README AUTODOCS regions in memory and compare against
 * the committed file, line-ending agnostic (a Windows autocrlf checkout stores
 * CRLF while we emit LF). Exits 1 on drift, 0 when current. No writes, no side
 * effects.
 */
function checkReadme(appMetas) {
  const readmePath = path.join(ROOT, 'README.md');
  const norm = (s) => s.replace(/\r\n?/g, '\n');
  const committed = fs.readFileSync(readmePath, 'utf-8');
  const expected = computeReadme(appMetas, { logging: false });
  if (norm(committed) !== norm(expected)) {
    console.error(
      '\n[stale] README.md AUTODOCS regions are out of date.\n' +
        'Run: pnpm docs:readme  (then commit the regenerated README.md).',
    );
    process.exit(1);
  }
  console.log('README.md AUTODOCS regions are current.');
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
  if (checkMode) {
    console.log('Stage 5: Publish (README check)');
  } else if (readmeOnly) {
    console.log('Stage 5: Publish (README only)');
  } else {
    console.log('Stage 5: Publish');
  }
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

  // --check: compare README AUTODOCS regions only; no writes, no side effects.
  if (checkMode) {
    console.log('[README check]');
    checkReadme(appMetas);
    return;
  }

  // 1. README rewrite
  console.log('[README rewrite]');
  rewriteReadme(appMetas);
  console.log('');

  // --readme-only stops here: no marketing sync, screenshot manifest, or regen
  // log side effects.
  if (readmeOnly) {
    console.log('Stage 5 complete (README only).');
    return;
  }

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
