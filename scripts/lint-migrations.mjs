#!/usr/bin/env node
// lint-migrations.mjs
//
// Enforces the migration conventions documented in CLAUDE.md under
// "Database Schema & Migrations > Migration conventions".
//
// Rules enforced:
//   1. Filename must match ^[0-9]{4}_[a-z][a-z0-9_]*\.sql$
//   2. First ~20 lines must contain:
//        -- NNNN_<name>.sql   (NNNN matching the filename prefix)
//        -- Why: ...
//        -- Client impact: ...
//   3. Idempotent DDL:
//        - CREATE TABLE            → must use IF NOT EXISTS
//        - CREATE [UNIQUE] INDEX   → must use IF NOT EXISTS
//                                    (or be preceded by DROP INDEX IF EXISTS within 3 lines)
//        - ADD COLUMN              → must use IF NOT EXISTS
//        - DROP TABLE|INDEX|COLUMN → must use IF EXISTS
//        - CREATE TRIGGER          → must be preceded by DROP TRIGGER IF EXISTS
//                                    within the same file, OR wrapped in a DO $$ block
//                                    (DO $$ appears within 5 lines above)
//        - CREATE TYPE ... AS ENUM → warn (no IF NOT EXISTS syntax exists)
//
// Inline escape: append `-- noqa: <rule-name>` on the offending line to
// silence a single rule. Use sparingly and only with justification.
//
// ⚠ MIGRATION IMMUTABILITY. Once a migration has been applied in ANY
// environment (dev, staging, prod), its SQL body is frozen — the runner in
// apps/api/src/migrate.ts hashes the body (leading `--` comment block is
// stripped, but everything after the header including inline comments is
// part of the hash) and refuses to run the file when the hash drifts. If a
// lint violation fires on an already-applied migration, do NOT add an
// inline `-- noqa:` tag: that changes the body and breaks every environment
// that has the file recorded with the old hash. Instead, register the
// suppression in the OFF_FILE_SUPPRESSIONS map below. See CLAUDE.md under
// "Migration conventions" for the incident that motivated this mechanism.
//
// Usage: node scripts/lint-migrations.mjs
// Exit:  0 on clean, 1 on any violation.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'infra', 'postgres', 'migrations');

const FILENAME_RE = /^[0-9]{4}_[a-z][a-z0-9_]*\.sql$/;
const HEADER_SCAN_LINES = 20;

/**
 * Off-file suppressions for already-applied migrations. Shape:
 *   { [filename]: { [lineNumber]: [rule, ...] } }
 *
 * Use this instead of adding an inline `-- noqa:` tag to a migration that has
 * already been applied in any environment. Editing the body retroactively
 * triggers the runner's checksum-mismatch guard and blocks every subsequent
 * migration on that DB (the 2026-04-18 incident where production stalled at
 * 0124 until an operator ran once with MIGRATE_ALLOW_HEADER_RESTAMP=1).
 *
 * The 0124 entries below document the false positives that were inside a
 * `DO $$ BEGIN IF EXISTS ... END $$` block with runtime idempotency guards.
 * They are also still silenced by inline `-- noqa:` tags left in the file so
 * production's re-stamped hash continues to match; removing the tags would
 * re-break the hash. Keep BOTH suppressions in place — the file is frozen.
 */
const OFF_FILE_SUPPRESSIONS = {
  '0124_banter_messages_partition_conversion.sql': {
    39: ['drop-if-exists'],
    45: ['create-table-if-not-exists'],
  },
  // Unguarded `CREATE TYPE ... AS ENUM` in migrations that predate the
  // create-enum-guarded rule. All six files are applied everywhere
  // (bodies frozen); on re-runs the runner skips them via
  // schema_migrations, and on a fresh DB the unguarded CREATE TYPE
  // succeeds — the warning is purely historical noise. New migrations
  // must still wrap CREATE TYPE in a duplicate_object guard.
  '0023_beacon_tables.sql': {
    13: ['create-enum-guarded'],
    20: ['create-enum-guarded'],
    27: ['create-enum-guarded'],
    34: ['create-enum-guarded'],
    41: ['create-enum-guarded'],
    48: ['create-enum-guarded'],
    55: ['create-enum-guarded'],
  },
  '0024_brief_tables.sql': {
    12: ['create-enum-guarded'],
    19: ['create-enum-guarded'],
    26: ['create-enum-guarded'],
    33: ['create-enum-guarded'],
    40: ['create-enum-guarded'],
  },
  '0026_bolt_tables.sql': {
    11: ['create-enum-guarded'],
    16: ['create-enum-guarded'],
    24: ['create-enum-guarded'],
    29: ['create-enum-guarded'],
    34: ['create-enum-guarded'],
    39: ['create-enum-guarded'],
  },
  '0127_agent_identity_heartbeat.sql': {
    17: ['create-enum-guarded'],
  },
  '0128_agent_proposals.sql': {
    13: ['create-enum-guarded'],
  },
  '0132_entity_links.sql': {
    13: ['create-enum-guarded'],
  },
};

function hasOffFileSuppression(filename, lineNumber, rule) {
  const fileMap = OFF_FILE_SUPPRESSIONS[filename];
  if (!fileMap) return false;
  const rules = fileMap[lineNumber];
  if (!rules) return false;
  return rules.includes(rule) || rules.includes('all');
}

// Strip SQL comments from lines for DDL matching. Preserves line count so
// that line numbers reported to the user match the original file. Handles
// both -- line comments and /* block comments */ (block state carried
// across lines).
function stripComments(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      // line comment
      if (line[i] === '-' && line[i + 1] === '-') {
        break; // rest of line is a comment
      }
      // block comment start
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      s += line[i];
      i++;
    }
    out.push(s);
  }
  return out;
}

function hasNoqa(rawLine, rule) {
  const m = rawLine.match(/--\s*noqa:\s*([a-z0-9_,\s-]+)/i);
  if (!m) return false;
  const rules = m[1].split(',').map((x) => x.trim().toLowerCase());
  return rules.includes(rule.toLowerCase()) || rules.includes('all');
}

function checkFile(filename, content) {
  const violations = [];
  const warnings = [];

  // Rule 1: filename
  if (!FILENAME_RE.test(filename)) {
    violations.push({
      line: 0,
      rule: 'filename-pattern',
      msg: 'filename must match ^[0-9]{4}_[a-z][a-z0-9_]*\\.sql$',
    });
  }

  const rawLines = content.split(/\r?\n/);

  // Rule 2: header
  const prefix = filename.slice(0, 4);
  const headerSlice = rawLines.slice(0, HEADER_SCAN_LINES).join('\n');
  const hasFilenameLine = new RegExp(`--\\s*${prefix}_[a-z0-9_]*\\.sql`, 'i').test(headerSlice);
  const hasWhy = /--\s*Why:\s*\S/i.test(headerSlice);
  const hasImpact = /--\s*Client impact:\s*\S/i.test(headerSlice);

  const headerNoqa =
    rawLines.slice(0, HEADER_SCAN_LINES).some((l) => hasNoqa(l, 'header-required'))
    || hasOffFileSuppression(filename, 1, 'header-required');
  if (!headerNoqa) {
    if (!hasFilenameLine) {
      violations.push({ line: 1, rule: 'header-required', msg: `missing "-- ${prefix}_<name>.sql" line in first ${HEADER_SCAN_LINES} lines` });
    }
    if (!hasWhy) {
      violations.push({ line: 1, rule: 'header-required', msg: `missing "-- Why: ..." in first ${HEADER_SCAN_LINES} lines` });
    }
    if (!hasImpact) {
      violations.push({ line: 1, rule: 'header-required', msg: `missing "-- Client impact: ..." in first ${HEADER_SCAN_LINES} lines` });
    }
  }

  // Rule 3+: strip comments for DDL matching, preserve line numbers
  const stripped = stripComments(rawLines);

  const check = (lineIdx, rule, msg) => {
    if (hasNoqa(rawLines[lineIdx], rule)) return;
    if (hasOffFileSuppression(filename, lineIdx + 1, rule)) return;
    violations.push({ line: lineIdx + 1, rule, msg });
  };

  // Regexes — case-insensitive
  const reCreateTable = /\bcreate\s+table\b/i;
  const reCreateTableOk = /\bcreate\s+table\s+if\s+not\s+exists\b/i;

  const reCreateIndex = /\bcreate\s+(unique\s+)?index\b/i;
  const reCreateIndexOk = /\bcreate\s+(unique\s+)?index\s+if\s+not\s+exists\b/i;
  const reDropIndexIfExists = /\bdrop\s+index\s+if\s+exists\b/i;

  const reAddColumn = /\badd\s+column\b/i;
  const reAddColumnOk = /\badd\s+column\s+if\s+not\s+exists\b/i;

  const reDropThing = /\bdrop\s+(table|index|column)\b/i;
  const reDropThingOk = /\bdrop\s+(table|index|column)\s+if\s+exists\b/i;

  const reCreateTrigger = /\bcreate\s+(or\s+replace\s+)?(constraint\s+)?trigger\b/i;
  const reDropTriggerIfExists = /\bdrop\s+trigger\s+if\s+exists\b/i;
  const reDoBlock = /\bdo\s+\$\$/i;

  const reCreateEnum = /\bcreate\s+type\b[^;]*\bas\s+enum\b/i;

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    if (!line.trim()) continue;

    if (reCreateTable.test(line) && !reCreateTableOk.test(line)) {
      check(i, 'create-table-if-not-exists', 'CREATE TABLE must use IF NOT EXISTS');
    }

    if (reCreateIndex.test(line) && !reCreateIndexOk.test(line)) {
      // Allow if preceded by DROP INDEX IF EXISTS within 3 lines (stripped)
      let ok = false;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (reDropIndexIfExists.test(stripped[j])) { ok = true; break; }
      }
      if (!ok) {
        check(i, 'create-index-if-not-exists', 'CREATE INDEX must use IF NOT EXISTS (or be preceded by DROP INDEX IF EXISTS within 3 lines)');
      }
    }

    if (reAddColumn.test(line) && !reAddColumnOk.test(line)) {
      check(i, 'add-column-if-not-exists', 'ADD COLUMN must use IF NOT EXISTS');
    }

    if (reDropThing.test(line) && !reDropThingOk.test(line)) {
      check(i, 'drop-if-exists', 'DROP TABLE/INDEX/COLUMN must use IF EXISTS');
    }

    if (reCreateTrigger.test(line)) {
      // Must be preceded somewhere in the file by DROP TRIGGER IF EXISTS,
      // OR wrapped in a DO $$ block (DO $$ within 5 lines above).
      let hasDrop = false;
      for (let j = 0; j < i; j++) {
        if (reDropTriggerIfExists.test(stripped[j])) { hasDrop = true; break; }
      }
      let inDo = false;
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (reDoBlock.test(stripped[j])) { inDo = true; break; }
      }
      if (!hasDrop && !inDo) {
        check(i, 'create-trigger-guarded', 'CREATE TRIGGER must be preceded by DROP TRIGGER IF EXISTS or wrapped in DO $$ block');
      }
    }

    if (reCreateEnum.test(line)) {
      if (!hasNoqa(rawLines[i], 'create-enum-guarded')
          && !hasOffFileSuppression(filename, i + 1, 'create-enum-guarded')) {
        warnings.push({ line: i + 1, rule: 'create-enum-guarded', msg: 'CREATE TYPE ... AS ENUM has no IF NOT EXISTS; wrap in DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;' });
      }
    }
  }

  return { violations, warnings };
}

function main() {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(`[lint-migrations] directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[lint-migrations] no migration files found');
    process.exit(0);
  }

  let totalViolations = 0;
  let totalWarnings = 0;

  for (const filename of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
    const { violations, warnings } = checkFile(filename, content);

    for (const v of violations) {
      console.error(`${filename}:${v.line}  [${v.rule}] ${v.msg}`);
      totalViolations++;
    }
    for (const w of warnings) {
      console.warn(`${filename}:${w.line}  [warn:${w.rule}] ${w.msg}`);
      totalWarnings++;
    }
  }

  console.log(
    `\n[lint-migrations] checked ${files.length} file(s) — ${totalViolations} violation(s), ${totalWarnings} warning(s)`,
  );

  process.exit(totalViolations > 0 ? 1 : 0);
}

main();
