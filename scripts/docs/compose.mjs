#!/usr/bin/env node

/**
 * Stage 4: Compose
 *
 * Assembles guide.md and marketing.md for each app from extracted metadata,
 * screenshots, MCP tools, and narrative partials.
 *
 * Usage:
 *   node scripts/docs/compose.mjs [--apps bond,bench] [--dry-run]
 */

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

/**
 * Human-friendly app display name.
 */
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

/**
 * Short description for stub generation when no narrative exists.
 */
function shortDescription(appName) {
  const descriptions = {
    bam: 'sprint-based Kanban project management with drag-and-drop boards, custom fields, and carry-forward mechanics',
    banter: 'real-time team messaging with channels, threads, reactions, and file sharing',
    beacon: 'knowledge base and documentation with full-text search, graph exploration, and policy management',
    bearing: 'goals and OKR tracking with key results, progress reporting, and timeline views',
    bench: 'analytics dashboards with configurable widgets, ad-hoc queries, and scheduled reports',
    bill: 'invoicing and billing with line items, payment tracking, and PDF generation',
    blank: 'form builder with conditional logic, submissions, and public form links',
    blast: 'email campaign management with templates, audience segments, and delivery analytics',
    board: 'infinite canvas whiteboard with real-time collaboration, shapes, and audio conferencing',
    bolt: 'workflow automation engine with visual rule builder, triggers, and execution logs',
    bond: 'CRM with contacts, companies, deal pipelines, activities, and revenue forecasting',
    book: 'appointment scheduling with availability rules, booking pages, and calendar integrations',
    brief: 'collaborative document editor with real-time co-editing, templates, and version history',
    helpdesk: 'customer support portal with ticket management, SLA tracking, and a public-facing help center',
  };
  return descriptions[appName] || `the ${capitalize(appName)} module of BigBlueBam`;
}

// ---------------------------------------------------------------------------
// Agent invocation infrastructure (stub for v1)
// ---------------------------------------------------------------------------

/**
 * Prompt template for the doc-writer agent. In a future version, this would
 * be sent to the Claude API. For now it is logged and skipped.
 */
function buildNarrativePrompt(appName, meta, mcpToolNames, screenshotLabels, relatedApps) {
  return [
    `You are writing the technical instruction guide for "${displayName(appName)}",`,
    `a module in the BigBlueBam productivity suite.`,
    '',
    `App details:`,
    `- Nginx path: ${meta.nginx_path}`,
    `- API port: ${meta.api_port}`,
    `- Route files: ${meta.route_files}`,
    `- Schema modules: ${meta.schema_modules}`,
    `- MCP tools: ${mcpToolNames.join(', ')}`,
    '',
    screenshotLabels.length > 0
      ? `Screenshots available: ${screenshotLabels.join(', ')}`
      : 'No screenshots available yet.',
    '',
    relatedApps.length > 0
      ? `Related apps: ${relatedApps.join(', ')}`
      : '',
    '',
    `Write a clear, practical guide covering what this module does, how users`,
    `navigate it, and the key workflows. Use markdown. Do not use em dashes.`,
    `Target length: 400-800 words.`,
  ].filter(Boolean).join('\n');
}

/**
 * Check whether a narrative refresh is needed based on changed-apps.json.
 */
function shouldRefreshNarrative(appName) {
  const changedPath = path.join(ROOT, 'docs', 'auto', 'changed-apps.json');
  if (!fs.existsSync(changedPath)) return true;
  try {
    const data = JSON.parse(fs.readFileSync(changedPath, 'utf-8'));
    return data.changed.some((c) => c.app === appName);
  } catch {
    return true;
  }
}

/**
 * Attempt to refresh narrative via agent. In v1, this is a no-op stub.
 * Returns true if the agent was invoked (would have been), false otherwise.
 */
function attemptNarrativeRefresh(appName, meta, mcpToolNames, screenshotLabels, relatedApps) {
  const prompt = buildNarrativePrompt(appName, meta, mcpToolNames, screenshotLabels, relatedApps);
  console.log(`  Would invoke doc-writer agent for ${appName}`);
  if (dryRun) {
    console.log(`  [dry-run] Prompt length: ${prompt.length} chars`);
  }
  // In a future version, this would call the Claude API with the prompt
  // and write the result to _narrative.md. For now, return false to
  // indicate no actual refresh happened.
  return false;
}

// ---------------------------------------------------------------------------
// Screenshot discovery
// ---------------------------------------------------------------------------

function discoverScreenshots(appDocsDir) {
  const lightDir = path.join(appDocsDir, 'screenshots', 'light');
  if (!fs.existsSync(lightDir)) return [];
  const files = fs.readdirSync(lightDir).filter((f) => f.endsWith('.png')).sort();
  return files.map((f) => {
    const id = f.replace(/\.png$/, '');
    // Derive a label from the id: "01-pipeline" -> "Pipeline"
    const label = id.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { id, file: f, label };
  });
}

// ---------------------------------------------------------------------------
// Cross-reference scanning
// ---------------------------------------------------------------------------

/**
 * Scan other apps' _narrative.md files for mentions of the given app name.
 * Returns a list of app names that reference this one.
 */
function findRelatedApps(appName, allAppNames) {
  const related = [];
  for (const other of allAppNames) {
    if (other === appName) continue;
    const narrativePath = path.join(ROOT, 'docs', 'apps', other, '_narrative.md');
    if (!fs.existsSync(narrativePath)) continue;
    const content = fs.readFileSync(narrativePath, 'utf-8');
    // Look for references to this app (case-insensitive word boundary)
    const pattern = new RegExp(`\\b${appName}\\b`, 'i');
    if (pattern.test(content)) {
      related.push(other);
    }
  }
  return related;
}

// ---------------------------------------------------------------------------
// Guide assembly
// ---------------------------------------------------------------------------

function composeGuide(appName, appDocsDir, meta, allAppNames) {
  const screenshots = discoverScreenshots(appDocsDir);
  const screenshotLabels = screenshots.map((s) => s.label);
  const relatedApps = findRelatedApps(appName, allAppNames);

  // Read or generate narrative
  const narrativePath = path.join(appDocsDir, '_narrative.md');
  let narrative = readFileOr(narrativePath, null);

  if (narrative === null) {
    // No narrative exists. Check if agent refresh would run.
    const refreshed = attemptNarrativeRefresh(appName, meta, [], screenshotLabels, relatedApps);
    if (!refreshed) {
      // Generate a stub
      narrative = [
        `This guide covers ${shortDescription(appName)}.`,
        '',
        `${displayName(appName)} is accessible at \`${meta.nginx_path}\` and provides`,
        `${meta.route_files} API route modules backed by ${meta.schema_modules} database schema modules.`,
        meta.mcp_tool_count > 0
          ? `It exposes ${meta.mcp_tool_count} MCP tools for AI-assisted workflows.`
          : '',
        '',
        '_This narrative will be expanded in a future documentation pass._',
      ].filter((line) => line !== undefined).join('\n');

      // Write the stub so future runs can reuse it
      if (!dryRun) {
        fs.writeFileSync(narrativePath, narrative + '\n', 'utf-8');
      }
      console.log(`  Generated narrative stub`);
    }
  } else if (shouldRefreshNarrative(appName)) {
    // Narrative exists but app changed. Try agent refresh.
    const mcpToolsPath = path.join(appDocsDir, 'mcp-tools.md');
    const mcpContent = readFileOr(mcpToolsPath, '');
    const toolNames = [...mcpContent.matchAll(/`(\w+)`/g)].map((m) => m[1]).filter((n) => n.includes('_'));
    attemptNarrativeRefresh(appName, meta, toolNames, screenshotLabels, relatedApps);
    // Agent is a no-op in v1, so we keep existing narrative
    console.log(`  Reusing existing narrative (agent refresh is a no-op in v1)`);
  } else {
    console.log(`  Reusing existing narrative (no source changes)`);
  }

  // Read MCP tools content
  const mcpToolsPath = path.join(appDocsDir, 'mcp-tools.md');
  const mcpToolsContent = readFileOr(mcpToolsPath, '_MCP tool catalog not yet generated. Run `pnpm docs:extract` first._');

  // Assemble guide.md
  const timestamp = new Date().toISOString();
  const sections = [];

  // Frontmatter
  sections.push([
    '---',
    `title: "${displayName(appName)} Guide"`,
    `app: ${appName}`,
    `generated: "${timestamp}"`,
    '---',
  ].join('\n'));

  // Title
  sections.push(`# ${displayName(appName)} Guide\n`);

  // Narrative
  sections.push(narrative.trim());

  // Walkthrough (screenshots)
  if (screenshots.length > 0) {
    const walkthroughLines = ['## Walkthrough\n'];
    for (const shot of screenshots) {
      walkthroughLines.push(`### ${shot.label}\n`);
      walkthroughLines.push(`![${shot.label}](screenshots/light/${shot.file})\n`);
    }
    sections.push(walkthroughLines.join('\n'));
  }

  // MCP Tools
  sections.push('## MCP Tools\n');
  sections.push(mcpToolsContent.trim());

  // Related Apps
  if (relatedApps.length > 0) {
    const relatedLines = ['## Related Apps\n'];
    for (const rel of relatedApps) {
      relatedLines.push(`- [${displayName(rel)}](../${rel}/guide.md)`);
    }
    sections.push(relatedLines.join('\n'));
  }

  const guideContent = sections.join('\n\n') + '\n';
  const guidePath = path.join(appDocsDir, 'guide.md');
  if (!dryRun) {
    ensureDir(appDocsDir);
    fs.writeFileSync(guidePath, guideContent, 'utf-8');
  }
  console.log(`  guide.md written`);
}

// ---------------------------------------------------------------------------
// Marketing assembly
// ---------------------------------------------------------------------------

function composeMarketing(appName, appDocsDir, meta) {
  const screenshots = discoverScreenshots(appDocsDir);

  // Read marketing hook if it exists
  const hookPath = path.join(appDocsDir, '_marketing_hook.md');
  let hook = readFileOr(hookPath, null);

  if (hook === null) {
    // Generate a default hook from the app description
    hook = [
      `**${displayName(appName)}** -- ${shortDescription(appName)}.`,
      '',
      `- Streamline your ${appName} workflows from a single interface`,
      `- Collaborate with your team in real time`,
      `- Automate repetitive tasks with ${meta.mcp_tool_count} AI-powered tools`,
    ].join('\n');

    // Write the default so future runs can reuse it
    if (!dryRun) {
      fs.writeFileSync(hookPath, hook + '\n', 'utf-8');
    }
    console.log(`  Generated marketing hook stub`);
  }

  // Assemble marketing.md
  const timestamp = new Date().toISOString();
  const sections = [];

  // Frontmatter
  sections.push([
    '---',
    `title: "${displayName(appName)}"`,
    `app: ${appName}`,
    `generated: "${timestamp}"`,
    '---',
  ].join('\n'));

  // Title and hook
  sections.push(`# ${displayName(appName)}\n`);
  sections.push(hook.trim());

  // Hero screenshot
  if (screenshots.length > 0) {
    sections.push(`## See It in Action\n`);
    const hero = screenshots[0];
    sections.push(`![${hero.label}](screenshots/light/${hero.file})\n`);

    // Up to 2 supporting screenshots
    const supporting = screenshots.slice(1, 3);
    if (supporting.length > 0) {
      const supportLines = supporting.map(
        (s) => `![${s.label}](screenshots/light/${s.file})`,
      );
      sections.push(supportLines.join('\n\n'));
    }
  }

  // Footer
  sections.push([
    '---',
    '',
    `Part of the [BigBlueBam](/) productivity suite.`,
  ].join('\n'));

  const marketingContent = sections.join('\n\n') + '\n';
  const marketingPath = path.join(appDocsDir, 'marketing.md');
  if (!dryRun) {
    ensureDir(appDocsDir);
    fs.writeFileSync(marketingPath, marketingContent, 'utf-8');
  }
  console.log(`  marketing.md written`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('Stage 4: Compose');
  if (dryRun) console.log('  (dry-run mode)');
  console.log('');

  // Discover all apps that have meta.json (produced by extract stage)
  const appsDir = path.join(ROOT, 'docs', 'apps');
  if (!fs.existsSync(appsDir)) {
    console.error('ERROR: docs/apps/ does not exist. Run extract stage first (pnpm docs:extract).');
    process.exit(1);
  }

  const allAppNames = fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(appsDir, name, 'meta.json')));

  const appsToProcess = requestedApps
    ? allAppNames.filter((name) => requestedApps.includes(name))
    : allAppNames;

  if (appsToProcess.length === 0) {
    console.log('No apps to process. Run extract stage first.');
    return;
  }

  for (const appName of appsToProcess) {
    console.log(`[${appName}]`);
    const appDocsDir = path.join(appsDir, appName);
    const metaPath = path.join(appDocsDir, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (err) {
      console.error(`  ERROR: Could not read meta.json: ${err.message}`);
      continue;
    }

    composeGuide(appName, appDocsDir, meta, allAppNames);
    composeMarketing(appName, appDocsDir, meta);
    console.log('');
  }

  console.log('Stage 4 complete.');
}

main();
