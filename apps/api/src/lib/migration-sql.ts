// SQL helpers for the migration runner (apps/api/src/migrate.ts).
//
// Issue #131: a handful of already-applied migrations (0078, 0156-0159) carry
// their own top-level `BEGIN;` / `COMMIT;`. The runner wraps every file in a
// transaction together with its `schema_migrations` INSERT, so the file's
// inner COMMIT ended that outer transaction early and the bookkeeping INSERT
// ran in autocommit. Those files are immutable (body checksum), so the runner
// removes top-level transaction-control statements from the SQL it EXECUTES,
// while the checksum is still computed from the file as it is on disk.
//
// scripts/lib/sql-top-level.mjs carries the same scanner for the migration
// linter (rule `no-transaction-control`), which rejects such statements in new
// migrations. Keep the two in step.

export interface TopLevelStatement {
  /** Statement text without the trailing semicolon. */
  text: string;
  /** Offset of the first character of the statement (after the previous `;`). */
  start: number;
  /** Offset just past the terminating `;` (or end of input). */
  end: number;
}

/**
 * Split SQL into top-level statements, honoring '...' and "..." quoting,
 * E'...' backslash escapes, -- and block comments, and $tag$ dollar quoting, so
 * a `BEGIN` / `END;` inside a function or DO body is never seen as top level.
 */
export function splitTopLevelStatements(sql: string): TopLevelStatement[] {
  const out: TopLevelStatement[] = [];
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
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
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

/** Statement text with comments removed and whitespace collapsed, upper-cased. */
function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const TRANSACTION_CONTROL =
  /^(BEGIN( TRANSACTION| WORK)?( ISOLATION LEVEL [A-Z ]+)?|START TRANSACTION( ISOLATION LEVEL [A-Z ]+)?|COMMIT( TRANSACTION| WORK)?)$/;

/** True when the statement is a top-level BEGIN / START TRANSACTION / COMMIT. */
export function isTransactionControl(text: string): boolean {
  return TRANSACTION_CONTROL.test(normalize(text));
}

/**
 * Remove top-level BEGIN / START TRANSACTION / COMMIT statements so the file
 * runs inside the runner's own transaction. Everything else, including
 * comments and line structure, is preserved. ROLLBACK is deliberately NOT
 * stripped: removing it would change what the file does.
 */
export function stripTopLevelTransactionControl(sql: string): { sql: string; removed: number } {
  let removed = 0;
  let result = '';
  let cursor = 0;
  for (const stmt of splitTopLevelStatements(sql)) {
    if (!isTransactionControl(stmt.text)) continue;
    // Keep any leading comments/whitespace before the keyword; drop the keyword
    // and its semicolon, replacing them with a newline per removed line break.
    const lead = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/.exec(stmt.text)?.[0] ?? '';
    const cut = stmt.start + lead.length;
    result += sql.slice(cursor, cut);
    const dropped = sql.slice(cut, stmt.end);
    result += dropped.replace(/[^\n]/g, '');
    cursor = stmt.end;
    removed++;
  }
  result += sql.slice(cursor);
  return { sql: result, removed };
}
