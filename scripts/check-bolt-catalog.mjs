#!/usr/bin/env node
/**
 * Bolt event-catalog drift guard (G4, Wave 2 P0).
 *
 * Two checks:
 *   1. Parses `apps/bolt-api/src/services/event-catalog.ts` to extract the set
 *      of declared `{ source, event_type }` pairs.
 *   2. Walks every .ts file under apps (excluding node_modules, dist, build,
 *      __tests__, *.d.ts, and *.test.ts), finds each publishBoltEvent(...)
 *      and publishBoltEventChecked(...) call (scripts/lib/bolt-publish-calls.mjs), extracts the first two string-literal arguments (event name,
 *      source), and verifies the pair is in the catalog AND that the event
 *      name is bare (no dotted source prefix).
 *   3. Treats every `enqueueBastionEvent('<event>', ...)` call as a `bastion`
 *      publisher (Bastion spec 8.1; scripts/lib/bolt-bastion-enqueues.mjs).
 *
 * Exits 1 on drift, 0 on clean. Intentionally minimal: this runs on every PR
 * and should never require a rebuild or a running database. All parsing is
 * regex-based with a simple balanced-paren walker for `publishBoltEvent(...)`
 * so multi-line calls work.
 *
 * Future enhancement: also query the live DB for `DISTINCT (trigger_source,
 * trigger_event) FROM bolt_automations WHERE enabled = true` and flag any
 * orphaned triggers. Skipped for this iteration to keep the script DB-free.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { BOLT_SOURCES_FILE, loadBoltSources } from './lib/bolt-sources.mjs';
import { checkBastionEnqueues } from './lib/bolt-bastion-enqueues.mjs';
import { checkPublishCalls } from './lib/bolt-publish-calls.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CATALOG_FILE = join(ROOT, 'apps', 'bolt-api', 'src', 'services', 'event-catalog.ts');
const APPS_DIR = join(ROOT, 'apps');
const EVENT_TYPE_REGEX = /source:\s*['"]([a-z_]+)['"][\s\S]{0,300}?event_type:\s*['"]([a-z0-9_.]+)['"]/g;

// Known legacy prefixed event names that predate the Wave 0.4 bare-name
// convention and have not yet been migrated. Each entry is (source:event_type).
// Adding to this set suppresses the drift guard for exactly that pair. Remove
// entries ONLY when the producer has been renamed AND a historical-rewrite
// migration (like 0096_bolt_event_naming_migration.sql) has shipped.
const LEGACY_PREFIXED_ALLOWLIST = new Set([]);

// Event-naming rule: the bare event name must NOT start with any known
// source prefix. Catalog sources are derived at runtime from the catalog itself.
function loadCatalog() {
  let text;
  try {
    text = readFileSync(CATALOG_FILE, 'utf8');
  } catch (err) {
    console.error(`[bolt-catalog] failed to read catalog: ${CATALOG_FILE}`);
    console.error(err.message);
    process.exit(2);
  }

  const pairs = new Set();
  const sources = new Set();
  let match;
  EVENT_TYPE_REGEX.lastIndex = 0;
  while ((match = EVENT_TYPE_REGEX.exec(text)) !== null) {
    const source = match[1];
    const eventType = match[2];
    pairs.add(`${source}:${eventType}`);
    sources.add(source);
  }

  if (pairs.size === 0) {
    console.error(`[bolt-catalog] no event definitions parsed from ${relative(ROOT, CATALOG_FILE)}`);
    console.error('Regex may be out of date. Expected source/event_type literal pattern.');
    process.exit(2);
  }

  return { pairs, sources };
}

// Recursively collect .ts files under apps/, skipping node_modules and dist/tests.
function walkTsFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'build' || name === '__tests__') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (st.isFile() && name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

function checkCalls(catalog) {
  const files = [];
  walkTsFiles(APPS_DIR, files);

  const violations = [];

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Bastion (spec 8.1) enqueues its events through an outbox; the drainer's own
    // publishBoltEvent call is dynamic, so the literal lives at the enqueue site.
    if (text.includes('enqueueBastionEvent')) violations.push(...checkBastionEnqueues(file, text, catalog));

    // Every positional publisher (publishBoltEvent and publishBoltEventChecked, issue #200).
    violations.push(...checkPublishCalls(file, text, catalog, LEGACY_PREFIXED_ALLOWLIST));
  }

  return violations;
}

function main() {
  const catalog = loadCatalog();
  console.log(`[bolt-catalog] parsed ${catalog.pairs.size} (source, event_type) pairs from catalog`);

  // Issue #124: every event source declared in the catalog must be a member of the
  // single shared BOLT_SOURCES list (which drives the ingest enum, TRIGGER_SOURCES,
  // TriggerSourceV1 and the Drizzle pgEnum; check-bolt-enum.mjs checks the DB enum).
  let boltSourceList;
  try {
    boltSourceList = loadBoltSources();
  } catch (err) {
    console.error(`[bolt-catalog] failed to read BOLT_SOURCES from ${relative(ROOT, BOLT_SOURCES_FILE)}: ${err.message}`);
    process.exit(2);
  }
  catalog.boltSources = new Set(boltSourceList);
  console.log(`[bolt-catalog] BOLT_SOURCES has ${boltSourceList.length} sources`);
  const sourceViolations = [...catalog.sources]
    .filter((s) => !catalog.boltSources.has(s))
    .map((s) => ({
      file: CATALOG_FILE,
      eventName: '*',
      source: s,
      reason: `catalog source "${s}" is not in BOLT_SOURCES (packages/shared/src/bolt-sources.ts)`,
    }));

  const violations = [...sourceViolations, ...checkCalls(catalog)];

  if (violations.length === 0) {
    console.log('[bolt-catalog] OK: all publishBoltEvent calls match the catalog');
    process.exit(0);
  }

  console.error(`[bolt-catalog] ${violations.length} violation(s) found:`);
  for (const v of violations) {
    console.error(`  ${relative(ROOT, v.file)}: ${v.reason}`);
  }
  process.exit(1);
}

main();
