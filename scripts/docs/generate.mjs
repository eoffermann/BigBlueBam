#!/usr/bin/env node

/**
 * Top-level orchestrator for the BigBlueBam autodocumentation pipeline.
 *
 * Runs stages in order: health check, capture, extract, compose, publish.
 *
 * Usage:
 *   node scripts/docs/generate.mjs                         # full rebuild
 *   node scripts/docs/generate.mjs --apps bond,bench       # partial run
 *   node scripts/docs/generate.mjs --skip-seed             # skip Stage 1 health check
 *   node scripts/docs/generate.mjs --dry-run               # plan only, no writes
 *   node scripts/docs/generate.mjs --skip-capture          # skip Stage 2 screenshot capture
 *   node scripts/docs/generate.mjs --init                  # inject README markers on first run
 */

import { execSync } from 'node:child_process';
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
const skipSeed = args.includes('--skip-seed');
const skipCapture = args.includes('--skip-capture');
const initMode = args.includes('--init');
const appsFlag = args.find((a) => a.startsWith('--apps='));

// Build forwarded args string
const forwardedArgs = [];
if (dryRun) forwardedArgs.push('--dry-run');
if (appsFlag) forwardedArgs.push(appsFlag);
if (initMode) forwardedArgs.push('--init');
const fwdStr = forwardedArgs.length > 0 ? ' ' + forwardedArgs.join(' ') : '';

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------
const lockPath = path.join(ROOT, '.regen-in-progress');

function acquireLock() {
  if (fs.existsSync(lockPath)) {
    const lockContent = fs.readFileSync(lockPath, 'utf-8').trim();
    console.error(`WARNING: Previous run may have crashed (lock file exists).`);
    console.error(`  Lock info: ${lockContent}`);
    console.error(`  Removing stale lock and continuing...`);
    console.error('');
  }
  if (!dryRun) {
    fs.writeFileSync(lockPath, `pid=${process.pid} started=${new Date().toISOString()}`, 'utf-8');
  }
}

function releaseLock() {
  try {
    if (!dryRun) fs.unlinkSync(lockPath);
  } catch {
    // Ignore if already removed
  }
}

// ---------------------------------------------------------------------------
// Stage runners
// ---------------------------------------------------------------------------

function runCommand(label, cmd) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log(`  [dry-run] Would execute: ${cmd}`);
    return;
  }

  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env } });
  } catch (err) {
    console.error(`\nERROR: ${label} failed with exit code ${err.status}`);
    releaseLock();
    process.exit(err.status || 1);
  }
}

function checkHealth() {
  console.log('\n--- Stage 1: Seed / Health Check ---\n');
  if (skipSeed) {
    console.log('  Skipped (--skip-seed)');
    return;
  }

  try {
    execSync(
      'node -e "fetch(\'http://localhost/b3/api/health\').then(r => { if (!r.ok) process.exit(1); process.exit(0); }).catch(() => process.exit(1))"',
      { cwd: ROOT, timeout: 10000, stdio: 'pipe' },
    );
    console.log('  Health check passed (GET /b3/api/health -> 200)');
  } catch {
    console.error('  WARNING: Health check failed. The stack may not be running.');
    console.error('  Continuing anyway (screenshot capture may fail).');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const startTime = Date.now();
  console.log('BigBlueBam Documentation Generator');
  console.log(`  Root: ${ROOT}`);
  console.log(`  Args: ${args.join(' ') || '(none)'}`);
  if (dryRun) console.log('  Mode: dry-run');
  console.log('');

  acquireLock();

  try {
    // Stage 1: Health check
    checkHealth();

    // Stage 2a: Capture (recipe-driven engine -> shared screenshots/ tree).
    // Credentials + target org come from the environment / screenshots.config.json
    // (see packages/docs-capture environment resolver); generate.mjs forwards none.
    const appsVal = appsFlag ? appsFlag.slice('--apps='.length) : '';
    if (skipCapture) {
      console.log('\n--- Stage 2a: Capture ---\n');
      console.log('  Skipped (--skip-capture)');
    } else {
      runCommand(
        'Stage 2a: Capture (recipe engine)',
        `pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts${appsVal ? ` --apps ${appsVal}` : ''}`,
      );
    }

    // Stage 2b: Bridge the shared tree into the docs layout (light/dark + meta.json)
    // for every capture that opted in via its recipe `doc:` field. Idempotent;
    // runs even with --skip-capture so docs reflect the current manifest.
    runCommand('Stage 2b: Bridge -> docs', `node scripts/docs/bridge.mjs${appsVal ? ` --apps=${appsVal}` : ''}`);

    // Stage 3: Extract
    runCommand('Stage 3: Extract', `node scripts/docs/extract.mjs${fwdStr}`);

    // Stage 3b: Build the marketing-site MCP tool catalog (site/src/content/
    // docs-catalog.generated.json) that the /docs page imports. Always runs the
    // full app roster (it derives everything from LAUNCHPAD_CATALOG + tool
    // source), so it ignores --apps; that keeps the committed catalog complete.
    runCommand('Stage 3b: Docs catalog', 'node scripts/docs/build-docs-catalog.mjs');

    // Stage 4: Compose
    runCommand('Stage 4: Compose', `node scripts/docs/compose.mjs${fwdStr}`);

    // Stage 5: Publish
    runCommand('Stage 5: Publish', `node scripts/docs/publish.mjs${fwdStr}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Pipeline complete in ${duration}s`);
    console.log(`${'='.repeat(60)}\n`);
  } finally {
    releaseLock();
  }
}

main();
