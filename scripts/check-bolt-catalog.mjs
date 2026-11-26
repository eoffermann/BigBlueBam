#!/usr/bin/env node
/**
 * Bolt event-catalog drift guard (G4, Wave 2 P0).
 *
 * Two checks:
 *   1. Parses `apps/bolt-api/src/services/event-catalog.ts` to extract the set
 *      of declared `{ source, event_type }` pairs.
 *   2. Walks every .ts file under apps (excluding node_modules, dist, build,
 *      __tests__, *.d.ts, and *.test.ts), finds each publishBoltEvent(...)
 *      call, extracts the first two string-literal arguments (event name,
 *      source), and verifies the pair is in the catalog AND that the event
 *      name is bare (no dotted source prefix).
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

/**
 * Balanced-paren walker: given `src` and a start index pointing at the `(`
 * after `publishBoltEvent`, returns the slice of arguments between `(` and the
 * matching `)`. Tracks string/template literals so parens inside them do not
 * confuse the walker.
 */
function extractArgs(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let inString = null;
  let escaped = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') {
        escaped = true;
      } else if (c === inString) {
        inString = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Top-level comma-aware argument splitter. Respects nested parens/brackets/
 * braces and strings so `{ foo: bar(1, 2) }` counts as a single argument.
 */
function splitTopLevelArgs(argText) {
  const out = [];
  let depth = 0;
  let inString = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  if (start < argText.length) out.push(argText.slice(start));
  return out.map((s) => s.trim());
}

/**
 * Parse a string literal argument: returns { ok, value } where value is the
 * string content if the arg is a plain single/double-quoted literal, else
 * null. Template literals with `${}` interpolation are rejected (we cannot
 * verify them statically). Simple backtick literals without interpolation
 * are accepted.
 */
function parseStringLiteralArg(arg) {
  if (arg.length < 2) return { ok: false, value: null };
  const first = arg[0];
  const last = arg[arg.length - 1];
  if ((first === "'" || first === '"') && last === first) {
    return { ok: true, value: arg.slice(1, -1) };
  }
  if (first === '`' && last === '`') {
    const inner = arg.slice(1, -1);
    if (inner.includes('${')) return { ok: false, value: null };
    return { ok: true, value: inner };
  }
  return { ok: false, value: null };
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
    // Fast reject before the slower walker.
    if (!text.includes('publishBoltEvent')) continue;

    let idx = 0;
    while ((idx = text.indexOf('publishBoltEvent', idx)) !== -1) {
      // Require word boundary on the left so we don't match something like
      // `xpublishBoltEvent`. Right-side: expect optional whitespace then `(`.
      const before = idx === 0 ? ' ' : text[idx - 1];
      if (/[A-Za-z0-9_$]/.test(before)) {
        idx += 'publishBoltEvent'.length;
        continue;
      }
      let after = idx + 'publishBoltEvent'.length;
      while (after < text.length && /\s/.test(text[after])) after += 1;
      if (text[after] !== '(') {
        idx = after;
        continue;
      }

      const argText = extractArgs(text, after);
      idx = after + 1;
      if (argText === null) continue;

      const args = splitTopLevelArgs(argText);
      if (args.length < 2) continue; // malformed; skip quietly

      const eventLit = parseStringLiteralArg(args[0]);
      const sourceLit = parseStringLiteralArg(args[1]);

      // If either arg is not a static literal, we cannot check it. This
      // keeps the guard conservative (dynamic callers are allowed) at the
      // cost of not catching every drift. Flag only when we're certain.
      if (!eventLit.ok || !sourceLit.ok) continue;

      const eventName = eventLit.value;
      const source = sourceLit.value;
      const key = `${source}:${eventName}`;

      // Rule 1: event name must be bare (no dotted source prefix).
      if (
        catalog.sources.has(eventName.split('.')[0]) &&
        eventName.split('.').length > 2 &&
        !LEGACY_PREFIXED_ALLOWLIST.has(key)
      ) {
        violations.push({
          file,
          eventName,
          source,
          reason: `event name "${eventName}" looks source-prefixed; use bare event name (e.g. "deal.rotting" not "bond.deal.rotting")`,
        });
        continue;
      }

      // Allowlisted legacy-prefixed events bypass the catalog lookup too —
      // they are tracked as TODOs, not new drift.
      if (LEGACY_PREFIXED_ALLOWLIST.has(key)) continue;

      // Rule 2a (issue #124): the source must be in the shared BOLT_SOURCES list, or
      // bolt-api ingest 400-rejects it and publishBoltEvent swallows the failure.
      if (catalog.boltSources && !catalog.boltSources.has(source)) {
        violations.push({
          file,
          eventName,
          source,
          reason: `source "${source}" is not in BOLT_SOURCES (packages/shared/src/bolt-sources.ts); bolt-api ingest would reject it`,
        });
        continue;
      }

      // Rule 2: (source, eventName) pair must exist in the catalog.
      if (!catalog.pairs.has(key)) {
        violations.push({
          file,
          eventName,
          source,
          reason: `(source="${source}", event_type="${eventName}") not found in event-catalog.ts`,
        });
      }
    }
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
