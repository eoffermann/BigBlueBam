#!/usr/bin/env node

/**
 * Stage 4: Compose
 *
 * Assembles guide.md and marketing.md for each app from extracted metadata,
 * screenshots, MCP tools, and the source partials _narrative.md (guide) and
 * _marketing_hook.md (marketing).
 *
 * Ownership (#398): compose only writes a file it generated itself. A generated
 * file carries GENERATED_MARKER (or, for files composed before the marker, a
 * `generated:` front-matter key). A guide.md or marketing.md without either is
 * hand-written and is never touched. An app with no source partial is skipped:
 * compose no longer invents stub narratives or hooks. A file whose content
 * would differ only in its `generated:` timestamp is left as is, so rerunning
 * the stage on unchanged sources produces no diff. See scripts/docs/lib/
 * generated-marker.mjs.
 *
 * Usage:
 *   node scripts/docs/compose.mjs [--apps=bond,bench] [--dry-run] [--root=<dir>]
 *
 * --root points the stage at another repo-shaped tree (used by the tests in
 * scripts/lib/docs-compose-ownership.test.mjs); it defaults to this repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_MARKER, isUnchanged, planOutput } from './lib/generated-marker.mjs';
import { appMetaPath } from './lib/app-doc-files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const appsFlag = args.find((a) => a.startsWith('--apps='));
const requestedApps = appsFlag
  ? appsFlag
      .split('=')[1]
      .split(',')
      .map((s) => s.trim())
  : null;
const rootFlag = args.find((a) => a.startsWith('--root='));
const ROOT = rootFlag
  ? path.resolve(rootFlag.slice('--root='.length))
  : path.resolve(__dirname, '..', '..');

// Per-run tally, printed at the end.
const tally = { written: [], unchanged: [], handwritten: [], noSource: [] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    bay: 'Bay (Media Review & Approval)',
    bearing: 'Bearing (Goals & OKRs)',
    bench: 'Bench (Analytics)',
    bill: 'Bill (Invoicing)',
    bin: 'Bin (Digital Asset Management)',
    blank: 'Blank (Forms)',
    blast: 'Blast (Email Campaigns)',
    blip: 'Blip (Telemetry)',
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
 * Write `content` to `filePath` unless the file there is hand-written, has no
 * source, or would change only in its timestamp. `plan` comes from planOutput.
 */
function emit(appName, fileName, filePath, plan, buildContent, sourceName) {
  const label = `${appName}/${fileName}`;
  if (plan === 'handwritten') {
    console.log(
      `  ${fileName}: SKIPPED, hand-written (no generated marker). Compose never overwrites it.`,
    );
    tally.handwritten.push(label);
    return;
  }
  if (plan === 'no-source') {
    console.log(`  ${fileName}: SKIPPED, no ${sourceName} to compose it from.`);
    tally.noSource.push(label);
    return;
  }
  const existing = readFileOr(filePath, null);
  const next = buildContent();
  if (isUnchanged(existing, next)) {
    console.log(`  ${fileName}: unchanged`);
    tally.unchanged.push(label);
    return;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, 'utf-8');
  }
  console.log(`  ${fileName}: ${dryRun ? '[dry-run] would write' : 'written'}`);
  tally.written.push(label);
}

/** Front matter + marker shared by both outputs. */
function header(title, appName) {
  return [
    [
      '---',
      `title: "${title}"`,
      `app: ${appName}`,
      `generated: "${new Date().toISOString()}"`,
      '---',
    ].join('\n'),
    GENERATED_MARKER,
  ];
}

// ---------------------------------------------------------------------------
// Agent invocation infrastructure (stub for v1)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Screenshot discovery
// ---------------------------------------------------------------------------

function discoverScreenshots(appDocsDir) {
  const lightDir = path.join(appDocsDir, 'screenshots', 'light');
  if (!fs.existsSync(lightDir)) return [];
  const files = fs
    .readdirSync(lightDir)
    .filter((f) => f.endsWith('.png'))
    .sort();
  return files.map((f) => {
    const id = f.replace(/\.png$/, '');
    // Derive a label from the id: "01-pipeline" -> "Pipeline"
    const label = id
      .replace(/^\d+-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
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

function composeGuide(appName, appDocsDir, allAppNames) {
  const guidePath = path.join(appDocsDir, 'guide.md');
  const narrative = readFileOr(path.join(appDocsDir, '_narrative.md'), null);
  const plan = planOutput({ existing: readFileOr(guidePath, null), source: narrative });

  emit(
    appName,
    'guide.md',
    guidePath,
    plan,
    () => {
      if (shouldRefreshNarrative(appName)) {
        console.log('  Reusing existing narrative (agent refresh is a no-op in v1)');
      }
      const screenshots = discoverScreenshots(appDocsDir);
      const relatedApps = findRelatedApps(appName, allAppNames);
      const mcpToolsContent = readFileOr(
        path.join(appDocsDir, 'mcp-tools.md'),
        '_MCP tool catalog not yet generated. Run `pnpm docs:extract` first._',
      );

      const sections = [...header(`${displayName(appName)} Guide`, appName)];
      sections.push(`# ${displayName(appName)} Guide\n`);
      sections.push(narrative.trim());

      if (screenshots.length > 0) {
        const walkthroughLines = ['## Walkthrough\n'];
        for (const shot of screenshots) {
          walkthroughLines.push(`### ${shot.label}\n`);
          walkthroughLines.push(`![${shot.label}](screenshots/light/${shot.file})\n`);
        }
        sections.push(walkthroughLines.join('\n'));
      }

      sections.push('## MCP Tools\n');
      sections.push(mcpToolsContent.trim());

      if (relatedApps.length > 0) {
        const relatedLines = ['## Related Apps\n'];
        for (const rel of relatedApps) {
          relatedLines.push(`- [${displayName(rel)}](../${rel}/guide.md)`);
        }
        sections.push(relatedLines.join('\n'));
      }

      return `${sections.join('\n\n')}\n`;
    },
    '_narrative.md',
  );
}

// ---------------------------------------------------------------------------
// Marketing assembly
// ---------------------------------------------------------------------------

function composeMarketing(appName, appDocsDir) {
  const marketingPath = path.join(appDocsDir, 'marketing.md');
  const hook = readFileOr(path.join(appDocsDir, '_marketing_hook.md'), null);
  const plan = planOutput({ existing: readFileOr(marketingPath, null), source: hook });

  emit(
    appName,
    'marketing.md',
    marketingPath,
    plan,
    () => {
      const screenshots = discoverScreenshots(appDocsDir);
      const sections = [...header(displayName(appName), appName)];
      sections.push(`# ${displayName(appName)}\n`);
      sections.push(hook.trim());

      if (screenshots.length > 0) {
        sections.push('## See It in Action\n');
        const hero = screenshots[0];
        sections.push(`![${hero.label}](screenshots/light/${hero.file})\n`);

        // Up to 2 supporting screenshots
        const supporting = screenshots.slice(1, 3);
        if (supporting.length > 0) {
          sections.push(
            supporting.map((s) => `![${s.label}](screenshots/light/${s.file})`).join('\n\n'),
          );
        }
      }

      sections.push(['---', '', 'Part of the [BigBlueBam](/) productivity suite.'].join('\n'));
      return `${sections.join('\n\n')}\n`;
    },
    '_marketing_hook.md',
  );
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

  const allAppNames = fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(appMetaPath(ROOT, name)));

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
    composeGuide(appName, appDocsDir, allAppNames);
    composeMarketing(appName, appDocsDir);
    console.log('');
  }

  const list = (xs) => (xs.length ? xs.join(', ') : 'none');
  console.log(`Written:   ${tally.written.length} (${list(tally.written)})`);
  console.log(`Unchanged: ${tally.unchanged.length}`);
  console.log(`Skipped, hand-written: ${tally.handwritten.length} (${list(tally.handwritten)})`);
  console.log(`Skipped, no source partial: ${tally.noSource.length} (${list(tally.noSource)})`);
  console.log('');
  console.log('Stage 4 complete.');
}

main();
