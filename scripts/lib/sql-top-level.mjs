// Top-level SQL statement scanner for scripts/lint-migrations.mjs (issue #131).
//
// Mirrors splitTopLevelStatements / isTransactionControl in
// apps/api/src/lib/migration-sql.ts (the migrate runner cannot import from
// scripts/, and this script cannot import TypeScript). Keep the two in step;
// scripts/lib/sql-top-level.test.mjs pins the shared behavior.

/**
 * Split SQL into top-level statements, honoring '...' and "..." quoting,
 * E'...' backslash escapes, -- and block comments, and $tag$ dollar quoting.
 * Returns [{ text, start, end }] where end is just past the `;`.
 */
export function splitTopLevelStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === '"') {
      const close = sql.indexOf('"', i + 1);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      out.push({ text: sql.slice(start, i), start, end: i + 1 });
      start = i + 1;
    }
    i++;
  }
  if (start < n) out.push({ text: sql.slice(start), start, end: n });
  return out;
}

function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// The linter is stricter than the runner: it also rejects ROLLBACK and a bare
// END (a COMMIT synonym), which the runner leaves alone.
const LINT_TRANSACTION_CONTROL =
  /^(BEGIN( TRANSACTION| WORK)?( ISOLATION LEVEL [A-Z ]+)?|START TRANSACTION( ISOLATION LEVEL [A-Z ]+)?|COMMIT( TRANSACTION| WORK)?|END( TRANSACTION| WORK)?|ROLLBACK( TRANSACTION| WORK)?)$/;

/**
 * Top-level transaction-control statements in `sql`, as
 * [{ line (1-based, of the keyword), statement }].
 */
export function findTopLevelTransactionControl(sql) {
  const found = [];
  for (const stmt of splitTopLevelStatements(sql)) {
    const norm = normalize(stmt.text);
    if (!LINT_TRANSACTION_CONTROL.test(norm)) continue;
    const lead = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(stmt.text)?.[0] ?? '';
    const offset = stmt.start + lead.length;
    const line = sql.slice(0, offset).split('\n').length;
    found.push({ line, statement: norm });
  }
  return found;
}
