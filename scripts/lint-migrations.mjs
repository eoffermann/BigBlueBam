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
//   4. no-transaction-control: no top-level BEGIN / START TRANSACTION /
//      COMMIT / END / ROLLBACK (issue #131). The runner wraps every file and
//      its schema_migrations row in one transaction already. Statements inside
//      $$ function or DO bodies are not top level and are fine.
//   5. org-guc-nullif (#381): current_setting('app.current_org_id')::uuid
//      must be NULLIF(current_setting(...), '')::uuid (an emptied GUC is '').
//   6. drop-column-separate-release (#375): no DROP COLUMN on a table the
//      same file adds a column to; the contract ships in a later release.
//   7. unique-sequence-prefix (#386): no two files share a 4-digit prefix.
//      Same-numbered files apply in accidental alphabetical order. The
//      historical pairs (0141, 0226, 0227) were applied everywhere and must
//      never be renamed; they are suppressed at line 0 in
//      OFF_FILE_SUPPRESSIONS, so only a NEW duplicate is flagged.
//   (5, 6 and 7 live in scripts/lib/migration-lint-rules.mjs, unit tested.)
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
import { findTopLevelTransactionControl } from './lib/sql-top-level.mjs';
import {
  findBareOrgGucCasts,
  findDuplicateSequencePrefixes,
  findSameFileAddDropColumn,
  stripSqlComments,
} from './lib/migration-lint-rules.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// LINT_MIGRATIONS_DIR exists so scripts/lib/migration-lint-rules.test.mjs can run this exact
// linter over a fixture directory; CI and developers use the default.
const MIGRATIONS_DIR = process.env.LINT_MIGRATIONS_DIR
  ? resolve(process.env.LINT_MIGRATIONS_DIR)
  : resolve(__dirname, '..', 'infra', 'postgres', 'migrations');

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
    95: ['org-guc-nullif'],
  },
  '0128_agent_proposals.sql': {
    13: ['create-enum-guarded'],
    78: ['org-guc-nullif'],
  },
  '0132_entity_links.sql': {
    13: ['create-enum-guarded'],
    56: ['org-guc-nullif'],
  },
  // Self-transacting migrations that predate the no-transaction-control rule
  // (issue #131). Applied everywhere, bodies frozen. The migrate runner strips
  // their top-level BEGIN/COMMIT at execution time so the file and its
  // schema_migrations row commit atomically; new migrations must not do this.
  '0078_reconcile_bam_bearing_drift.sql': {
    14: ['no-transaction-control'],
    50: ['no-transaction-control'],
  },
  '0156_permissions_remediate_builtin_defaults.sql': {
    27: ['no-transaction-control'],
    252: ['no-transaction-control'],
  },
  '0157_permissions_tighten_member_defaults.sql': {
    23: ['no-transaction-control'],
    105: ['no-transaction-control'],
  },
  '0158_permissions_viewer_self_care.sql': {
    30: ['no-transaction-control'],
    103: ['no-transaction-control'],
  },
  '0159_permissions_drop_legacy_role_columns.sql': {
    13: ['no-transaction-control'],
    23: ['no-transaction-control'],
  },
  // drop-column-separate-release (#375): expand and contract of one table in
  // one file, predating the rule. Applied everywhere, bodies frozen. 0340 is
  // the Bay token_hash migration that motivated the rule; its drop already ran
  // wherever 0340 applied, so it cannot be split retroactively.
  '0029_bearing_schema_alignment.sql': {
    30: ['drop-column-separate-release'],
    31: ['drop-column-separate-release'],
    32: ['drop-column-separate-release'],
    33: ['drop-column-separate-release'],
    91: ['drop-column-separate-release'],
    92: ['drop-column-separate-release'],
  },
  '0340_bay_review_link_token_hash.sql': {
    42: ['drop-column-separate-release'],
  },
  // org-guc-nullif (#381): bare current_setting('app.current_org_id')::uuid
  // casts that predate the rule. Applied everywhere, bodies frozen; 0355
  // rewrote every live policy built from them to the NULLIF form at apply
  // time, and its own hit is the search string it rewrites, not a cast.
  '0116_rls_foundation.sql': {
    25: ['org-guc-nullif'],
    29: ['org-guc-nullif'],
    33: ['org-guc-nullif'],
    37: ['org-guc-nullif'],
    45: ['org-guc-nullif'],
    53: ['org-guc-nullif'],
    61: ['org-guc-nullif'],
    69: ['org-guc-nullif'],
    77: ['org-guc-nullif'],
    91: ['org-guc-nullif'],
    102: ['org-guc-nullif'],
  },
  // (0127, 0128 and 0132 also have org-guc-nullif lines; they are listed in
  // those files' entries above, since a second key would replace the first.)
  '0133_banter_channels_quiet_hours.sql': {
    45: ['org-guc-nullif'],
  },
  '0134_banter_agent_subscriptions.sql': {
    58: ['org-guc-nullif'],
  },
  '0136_dedupe_decisions.sql': {
    48: ['org-guc-nullif'],
  },
  '0139_agent_policies.sql': {
    43: ['org-guc-nullif'],
  },
  '0140_agent_runner_webhooks.sql': {
    71: ['org-guc-nullif'],
  },
  '0147_permissions_rls_uuid_cast.sql': {
    18: ['org-guc-nullif'],
    23: ['org-guc-nullif'],
    34: ['org-guc-nullif'],
    37: ['org-guc-nullif'],
    46: ['org-guc-nullif'],
    49: ['org-guc-nullif'],
    57: ['org-guc-nullif'],
    60: ['org-guc-nullif'],
  },
  '0149_permissions_divergence_log.sql': {
    58: ['org-guc-nullif'],
  },
  '0226_basis_core.sql': {
    0: ['unique-sequence-prefix'], // #386, see the historical-pairs block below
    94: ['org-guc-nullif'],
    99: ['org-guc-nullif'],
    104: ['org-guc-nullif'],
  },
  '0227_basis_snapshots_explanations.sql': {
    0: ['unique-sequence-prefix'], // #386, see the historical-pairs block below
    57: ['org-guc-nullif'],
    88: ['org-guc-nullif'],
  },
  '0230_braid_core.sql': {
    149: ['org-guc-nullif'],
    154: ['org-guc-nullif'],
    159: ['org-guc-nullif'],
    164: ['org-guc-nullif'],
  },
  '0231_braid_candidates_decisions.sql': {
    94: ['org-guc-nullif'],
    99: ['org-guc-nullif'],
  },
  '0234_bulwark_core.sql': {
    264: ['org-guc-nullif'],
    269: ['org-guc-nullif'],
    274: ['org-guc-nullif'],
    279: ['org-guc-nullif'],
    284: ['org-guc-nullif'],
    289: ['org-guc-nullif'],
    294: ['org-guc-nullif'],
  },
  '0235_bulwark_compliance.sql': {
    91: ['org-guc-nullif'],
    96: ['org-guc-nullif'],
  },
  '0239_burn_core.sql': {
    486: ['org-guc-nullif'],
    491: ['org-guc-nullif'],
    496: ['org-guc-nullif'],
    501: ['org-guc-nullif'],
    506: ['org-guc-nullif'],
    511: ['org-guc-nullif'],
    516: ['org-guc-nullif'],
  },
  '0240_burn_gate_variance.sql': {
    423: ['org-guc-nullif'],
    428: ['org-guc-nullif'],
    433: ['org-guc-nullif'],
    438: ['org-guc-nullif'],
  },
  '0241_burn_rates_rollups_rules.sql': {
    254: ['org-guc-nullif'],
    259: ['org-guc-nullif'],
    264: ['org-guc-nullif'],
  },
  '0251_bursar_rls.sql': {
    41: ['org-guc-nullif'],
    43: ['org-guc-nullif'],
    48: ['org-guc-nullif'],
  },
  '0252_bursar_settings_audit.sql': {
    47: ['org-guc-nullif'],
    49: ['org-guc-nullif'],
    54: ['org-guc-nullif'],
  },
  '0280_bastion_rls.sql': {
    35: ['org-guc-nullif'],
  },
  '0287_bastion_notice_markers.sql': {
    28: ['org-guc-nullif'],
  },
  '0355_rls_policies_nullif_org_guc.sql': {
    15: ['org-guc-nullif'],
  },
  // unique-sequence-prefix (#386): three historical pairs share a prefix. All
  // six files are applied everywhere and keyed by full filename in
  // schema_migrations, so renaming one would re-run it as a new migration;
  // they stay as they are. Line 0 is the filename-level slot. Any other file
  // that takes one of these prefixes is still flagged. 0226_basis_core.sql
  // and 0227_basis_snapshots_explanations.sql already have entries above (a
  // second key for a file would silently replace the first), so their line-0
  // suppression lives there.
  '0141_book_event_livekit_room.sql': { 0: ['unique-sequence-prefix'] },
  '0141_users_created_by.sql': { 0: ['unique-sequence-prefix'] },
  '0226_platform_backups.sql': { 0: ['unique-sequence-prefix'] },
  '0227_permissions_seed_actions_delta_020.sql': { 0: ['unique-sequence-prefix'] },
};

function hasOffFileSuppression(filename, lineNumber, rule) {
  const fileMap = OFF_FILE_SUPPRESSIONS[filename];
  if (!fileMap) return false;
  const rules = fileMap[lineNumber];
  if (!rules) return false;
  return rules.includes(rule) || rules.includes('all');
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
  const stripped = stripSqlComments(rawLines);

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

  // Rule: no top-level transaction control (issue #131). The runner already
  // wraps each file and its schema_migrations INSERT in one transaction; a
  // file-level COMMIT ends that early and leaves the bookkeeping row outside it.
  for (const { line, statement } of findTopLevelTransactionControl(content)) {
    check(
      line - 1,
      'no-transaction-control',
      `top-level ${statement} is not allowed; the migrate runner wraps each file in its own transaction`,
    );
  }

  // Rule: org-guc-nullif (#381). ''::uuid raises 22P02 on a pooled connection
  // whose org GUC was emptied by an earlier transaction-local set_config.
  const strippedText = stripped.join('\n');
  for (const { line } of findBareOrgGucCasts(strippedText)) {
    check(
      line - 1,
      'org-guc-nullif',
      "cast app.current_org_id as NULLIF(current_setting('app.current_org_id', true), '')::uuid; the bare ::uuid cast fails with 22P02 when the GUC is an empty string",
    );
  }

  // Rule: drop-column-separate-release (#375). Expand and contract of one
  // table in one file breaks the release that is still serving.
  for (const { line, table, column } of findSameFileAddDropColumn(strippedText)) {
    check(
      line - 1,
      'drop-column-separate-release',
      `DROP COLUMN ${table}.${column} in the same migration that adds a column to ${table}: ship the drop in a later migration, released after the code stops reading the column`,
    );
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

  // Rule 7: unique-sequence-prefix (#386). Every file in a shared-prefix group
  // is reported unless it is one of the suppressed historical files.
  for (const { prefix, files: group } of findDuplicateSequencePrefixes(files)) {
    for (const filename of group) {
      if (hasOffFileSuppression(filename, 0, 'unique-sequence-prefix')) continue;
      const others = group.filter((f) => f !== filename).join(', ');
      console.error(
        `${filename}:0  [unique-sequence-prefix] sequence ${prefix} is also used by ${others}; renumber this migration to the next free number (only if it has not been applied anywhere)`,
      );
      totalViolations++;
    }
  }

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
