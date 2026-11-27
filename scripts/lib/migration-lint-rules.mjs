// migration-lint-rules.mjs
//
// Whole-file rules for scripts/lint-migrations.mjs, kept in a module of their
// own so they can be unit tested (scripts/lib/migration-lint-rules.test.mjs).
// Each rule takes the migration text with comments already stripped (line
// structure preserved, see stripSqlComments) and returns findings with a
// 1-based line number.

// Strip SQL comments from lines. Preserves line count so line numbers
// reported to the user match the original file. Handles both -- line comments
// and /* block comments */ (block state carried across lines).
export function stripSqlComments(lines) {
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
      if (line[i] === '-' && line[i + 1] === '-') break;
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

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// `current_setting('app.current_org_id' [, true|false])` with optional
// `::text` on the name and doubled quotes (the form inside dynamic SQL).
const ORG_GUC_CALL =
  String.raw`current_setting\s*\(\s*'+app\.current_org_id'+(?:\s*::\s*text)?\s*(?:,\s*(?:true|false)\s*)?\)`;

// Bare casts: `current_setting(...)::uuid`, the deparsed
// `(current_setting(...))::uuid`, and `CAST(current_setting(...) AS uuid)`.
// The safe form `NULLIF(current_setting(...), '')::uuid` never matches,
// because the cast there follows NULLIF's parenthesis, not current_setting's.
const BARE_ORG_GUC_CAST_RES = [
  new RegExp(String.raw`\b${ORG_GUC_CALL}\s*\)?\s*::\s*uuid\b`, 'gi'),
  new RegExp(String.raw`\bcast\s*\(\s*${ORG_GUC_CALL}\s+as\s+uuid\b`, 'gi'),
];

/**
 * Rule `org-guc-nullif` (#381). A pooled connection that once ran a
 * transaction-local set_config('app.current_org_id', ...) keeps the GUC as an
 * empty string afterwards, and ''::uuid raises 22P02 (#363). Every cast of the
 * org GUC must go through NULLIF(..., '') so an unbound org reads as NULL.
 */
export function findBareOrgGucCasts(strippedText) {
  const found = new Map();
  for (const re of BARE_ORG_GUC_CAST_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(strippedText)) !== null) {
      const line = lineAt(strippedText, m.index);
      if (!found.has(line)) found.set(line, { line, match: m[0] });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function normalizeTable(name) {
  return name.replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
}

/**
 * Rule `drop-column-separate-release` (#375). A migration that adds a column
 * to a table and drops a column of the same table is an expand and a contract
 * in one deploy: the previous release still reads the dropped column while it
 * serves, and a rollback to it is impossible. The drop must ship in a later
 * migration, released after the code that stops reading the column.
 */
export function findSameFileAddDropColumn(strippedText) {
  const re = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("?[a-z_][\w$]*"?(?:\."?[a-z_][\w$]*"?)?)([^;]*)/gi;
  const adds = new Set();
  const drops = [];
  let m;
  while ((m = re.exec(strippedText)) !== null) {
    const table = normalizeTable(m[1]);
    const body = m[2];
    const bodyStart = m.index + m[0].length - body.length;
    if (/\badd\s+column\b/i.test(body)) adds.add(table);
    const dropRe = /\bdrop\s+column\s+(?:if\s+exists\s+)?("?[a-z_][\w$]*"?)/gi;
    let d;
    while ((d = dropRe.exec(body)) !== null) {
      drops.push({
        line: lineAt(strippedText, bodyStart + d.index),
        table,
        column: d[1].replace(/"/g, '').toLowerCase(),
      });
    }
  }
  return drops.filter((d) => adds.has(d.table));
}

/**
 * Rule `unique-sequence-prefix` (#386). Two migrations sharing a 4-digit
 * prefix apply in alphabetical order of the rest of the name, which is an
 * accident, not a decision (two branches merged a 0360 each on 2026-11-27).
 * The runner keys on the full filename so it tolerates them, which is why the
 * linter has to catch it. Returns one entry per shared prefix, with every file
 * that carries it, sorted.
 *
 * @param {string[]} filenames
 * @returns {Array<{ prefix: string, files: string[] }>}
 */
export function findDuplicateSequencePrefixes(filenames) {
  const byPrefix = new Map();
  for (const f of filenames) {
    const m = /^([0-9]{4})_/.exec(f);
    if (!m) continue;
    if (!byPrefix.has(m[1])) byPrefix.set(m[1], []);
    byPrefix.get(m[1]).push(f);
  }
  return [...byPrefix.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([prefix, files]) => ({ prefix, files: [...files].sort() }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}
