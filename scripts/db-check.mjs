#!/usr/bin/env node
/**
 * db-check.mjs - Drizzle / Postgres drift guard.
 *
 * Parses every Drizzle `pgTable(...)` declaration across every schema root
 * discovered under `apps/{name}/src/db/schema`, unions them by table name,
 * then compares the result against the live database pointed to by
 * DATABASE_URL.
 *
 * Exit codes:
 *   0 - schema in sync (missing columns/tables: none)
 *   1 - drift detected (Drizzle declares something the DB doesn't have, or
 *       the DB contains something no Drizzle schema knows about)
 *
 * Type mismatches are reported as WARNINGS and do not fail the build, because
 * the regex parser can't perfectly reproduce Postgres's canonical type names.
 *
 * Debugging:
 *   Set DEBUG_DB_CHECK=1 to print the discovered SCHEMA_ROOTS list on stderr
 *   before parsing. Useful for confirming a new product's schema directory
 *   is being walked after it ships.
 *
 * Dependencies: the `postgres` npm package (resolved from apps/api/node_modules).
 * No other runtime deps.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

/**
 * Discover every `apps/<name>/src/db/schema/` directory automatically rather
 * than hard-coding three roots and silently missing the other eleven products.
 * See Platform_Plan.md (2026-04-13-revised) §3.1 for the gap that motivated
 * this. The list is exported so the coverage regression test in
 * `scripts/db-check.coverage.test.mjs` can assert that every schema directory
 * on disk is present.
 */
const APPS_DIR = join(repoRoot, 'apps');
export const SCHEMA_ROOTS = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(APPS_DIR, e.name, 'src', 'db', 'schema'))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  })
  .sort();

if (process.env.DEBUG_DB_CHECK === '1') {
  console.error('[db-check] DEBUG_DB_CHECK=1: discovered schema roots:');
  for (const root of SCHEMA_ROOTS) {
    console.error('  ' + relative(repoRoot, root).replaceAll('\\', '/'));
  }
  console.error(`[db-check] ${SCHEMA_ROOTS.length} schema root(s) total`);
}

// Tables that are internal to Postgres / the migration runner and should not
// be expected in Drizzle schemas.
const DB_IGNORE_TABLES = new Set(['schema_migrations']);

// ---------------------------------------------------------------------------
// 1. Parse Drizzle schema files
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ColumnDecl
 * @property {string} name
 * @property {string} drizzleType   raw builder name: uuid, varchar, text, ...
 * @property {string} file
 * @property {number} line
 */

/**
 * @typedef {Object} TableDecl
 * @property {string} name
 * @property {Map<string, ColumnDecl>} columns
 * @property {string[]} sources        files where this table was declared
 */

/** @type {Map<string, TableDecl>} */
const drizzleTables = new Map();

/** Walk a directory tree, returning all .ts files. */
function walkTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTsFiles(p));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Find the matching closing brace for an opening brace at openIdx.
 * Returns the index of the matching close brace, or -1 on failure.
 * Naive: ignores braces that appear inside strings/comments. Good enough for
 * the hand-written, well-formatted schema files in this repo.
 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let inString = null; // "'", '"', '`', or null
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && n === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && n === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const PGTABLE_RE = /pgTable\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
// Column builder call: `colName: builderName('colName'...) ...`.
// We match the line-starting key, the builder fn name, and the first arg
// (actual Postgres column name). The parser falls back to the JS key if no
// string arg is provided.
const COLUMN_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:['"`]([^'"`]+)['"`])?/;

function parseSchemaFile(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const relPath = relative(repoRoot, filePath).replaceAll('\\', '/');

  PGTABLE_RE.lastIndex = 0;
  let m;
  while ((m = PGTABLE_RE.exec(src)) !== null) {
    const tableName = m[1];
    // Opening brace for the columns object is the character matched just
    // before the regex advanced; it is the `{` at m.index + m[0].length - 1.
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBrace(src, braceOpen);
    if (braceClose === -1) continue;
    const body = src.slice(braceOpen + 1, braceClose);

    // Column parsing: walk line by line.
    const existing = drizzleTables.get(tableName) ?? {
      name: tableName,
      columns: new Map(),
      sources: [],
    };
    if (!existing.sources.includes(relPath)) existing.sources.push(relPath);

    // Compute the absolute line number the columns object starts on.
    const startLine = src.slice(0, braceOpen).split('\n').length;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const cm = lines[i].match(COLUMN_RE);
      if (!cm) continue;
      const jsKey = cm[1];
      const builderName = cm[2];
      const sqlName = cm[3] ?? jsKey;
      // Skip things that look like nested callbacks / non-column helpers.
      if (builderName === 'sql' || builderName === 'index') continue;
      if (!existing.columns.has(sqlName)) {
        existing.columns.set(sqlName, {
          name: sqlName,
          drizzleType: builderName,
          file: relPath,
          line: startLine + i,
        });
      }
    }

    drizzleTables.set(tableName, existing);
  }
}

// ---------------------------------------------------------------------------
// Entry-point guard.
//
// This module is imported by `scripts/db-check.coverage.test.mjs` purely to
// read the SCHEMA_ROOTS export. When imported, we must NOT run the live-DB
// introspection or process.exit; only the script's own CLI execution should.
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (!isMain) {
  // Importer just wants the SCHEMA_ROOTS export. Skip the rest.
} else {
  for (const root of SCHEMA_ROOTS) {
    for (const f of walkTsFiles(root)) parseSchemaFile(f);
  }
  await runDriftCheck();
}

// ---------------------------------------------------------------------------
// 2. Introspect live DB (wrapped in runDriftCheck so the module is safely
//    importable by the coverage regression test without opening a DB pool).
// ---------------------------------------------------------------------------

async function runDriftCheck() {
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgresql://${process.env.POSTGRES_USER ?? 'bigbluebam'}:${
    process.env.POSTGRES_PASSWORD ?? 'changeme'
  }@${process.env.POSTGRES_HOST ?? 'localhost'}:${
    process.env.POSTGRES_PORT ?? '5432'
  }/${process.env.POSTGRES_DB ?? 'bigbluebam'}`;

// Resolve `postgres`. Under pnpm it may not be hoisted to the workspace root,
// so we fall back to (a) apps/api/node_modules/postgres, and (b) scanning
// node_modules/.pnpm/postgres@*/node_modules/postgres.
async function loadPostgres() {
  const candidates = [
    { anchor: repoRoot, spec: 'postgres' },
    { anchor: join(repoRoot, 'apps', 'api'), spec: 'postgres' },
  ];
  for (const c of candidates) {
    try {
      const r = createRequire(pathToFileURL(join(c.anchor, 'package.json')).href);
      const mod = r(c.spec);
      return mod.default ?? mod;
    } catch {
      // try next
    }
  }
  // pnpm fallback: scan .pnpm for any postgres@x.y.z directory
  try {
    const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
    const entries = readdirSync(pnpmDir);
    const match = entries.find((n) => /^postgres@\d/.test(n));
    if (match) {
      const direct = join(pnpmDir, match, 'node_modules', 'postgres');
      if (statSync(direct).isDirectory()) {
        const mod = await import(pathToFileURL(join(direct, 'package.json')).href, {
          with: { type: 'json' },
        });
        const pkg = mod.default;
        const entry = pkg.main ?? 'cjs/src/index.js';
        const url = pathToFileURL(join(direct, entry)).href;
        const loaded = await import(url);
        return loaded.default ?? loaded;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const postgres = await loadPostgres();
if (!postgres) {
  console.error(
    'Could not resolve the `postgres` package. Run `pnpm install` first.',
  );
  process.exit(2);
}

const sql = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });

/** @type {Map<string, Map<string, {name:string, dataType:string, udtName:string}>>} */
const dbTables = new Map();

try {
  const rows = await sql`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  for (const r of rows) {
    if (DB_IGNORE_TABLES.has(r.table_name)) continue;
    let t = dbTables.get(r.table_name);
    if (!t) {
      t = new Map();
      dbTables.set(r.table_name, t);
    }
    t.set(r.column_name, {
      name: r.column_name,
      dataType: r.data_type,
      udtName: r.udt_name,
    });
  }
} catch (err) {
  console.error('Failed to introspect database at', databaseUrl);
  console.error(err?.message ?? err);
  await sql.end({ timeout: 1 }).catch(() => {});
  process.exit(2);
}

await sql.end({ timeout: 5 }).catch(() => {});

// ---------------------------------------------------------------------------
// 3. Diff
// ---------------------------------------------------------------------------

/** @type {string[]} */ const errors = [];
/** @type {string[]} */ const warnings = [];

// Drizzle-builder -> canonical information_schema.data_type
const TYPE_MAP = {
  uuid: 'uuid',
  varchar: 'character varying',
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  smallint: 'smallint',
  boolean: 'boolean',
  jsonb: 'jsonb',
  json: 'json',
  timestamp: 'timestamp with time zone', // all our timestamps use { withTimezone: true }
  date: 'date',
  time: 'time without time zone',
  doublePrecision: 'double precision',
  real: 'real',
  numeric: 'numeric',
  decimal: 'numeric',
  serial: 'integer',
  bigserial: 'bigint',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
};

function typesCompatible(drizzleType, dbCol) {
  const expected = TYPE_MAP[drizzleType];
  if (!expected) return true; // unknown drizzle type → don't warn
  // Arrays: information_schema reports data_type = "ARRAY" and udt_name like "_uuid".
  if (dbCol.dataType === 'ARRAY') {
    return dbCol.udtName === `_${TYPE_MAP[drizzleType]?.split(' ')[0]}` || dbCol.udtName.endsWith(expected.split(' ')[0]);
  }
  return dbCol.dataType === expected;
}

function alterHint(table, col) {
  // Very rough suggestion. Caller must still author a proper migration.
  const t = col.drizzleType;
  const pg =
    t === 'varchar' ? 'varchar'
    : t === 'timestamp' ? 'timestamptz'
    : t === 'doublePrecision' ? 'double precision'
    : TYPE_MAP[t] ?? t;
  return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${pg};`;
}

// Tables declared in Drizzle but missing from DB
for (const [name, decl] of drizzleTables) {
  if (!dbTables.has(name)) {
    errors.push(
      `MISSING TABLE in DB: "${name}"\n` +
        `  declared in: ${decl.sources.join(', ')}\n` +
        `  fix: add a migration that CREATE TABLE IF NOT EXISTS ${name} (...)`,
    );
    continue;
  }
  const dbCols = dbTables.get(name);
  for (const [colName, colDecl] of decl.columns) {
    const dbCol = dbCols.get(colName);
    if (!dbCol) {
      errors.push(
        `MISSING COLUMN in DB: ${name}.${colName}\n` +
          `  declared at: ${colDecl.file}:${colDecl.line} as ${colDecl.drizzleType}\n` +
          `  fix: ${alterHint(name, colDecl)}`,
      );
      continue;
    }
    if (!typesCompatible(colDecl.drizzleType, dbCol)) {
      warnings.push(
        `TYPE MISMATCH: ${name}.${colName}: Drizzle ${colDecl.drizzleType} ` +
          `vs DB ${dbCol.dataType}${dbCol.dataType === 'ARRAY' ? `(${dbCol.udtName})` : ''} ` +
          `(${colDecl.file}:${colDecl.line})`,
      );
    }
  }
}

// Tables/columns in DB but not declared in any Drizzle schema
for (const [tableName, dbCols] of dbTables) {
  const decl = drizzleTables.get(tableName);
  if (!decl) {
    errors.push(
      `UNKNOWN TABLE in DB: "${tableName}": no Drizzle schema declares it.\n` +
        `  fix: add a Drizzle schema file, or drop the table in a migration.`,
    );
    continue;
  }
  for (const [colName] of dbCols) {
    if (!decl.columns.has(colName)) {
      errors.push(
        `UNKNOWN COLUMN in DB: ${tableName}.${colName}: not declared in any Drizzle schema.\n` +
          `  fix: add the column to a Drizzle schema, or drop it in a migration.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------

const tablesScanned = drizzleTables.size;
const dbTableCount = dbTables.size;

if (warnings.length > 0) {
  console.log('\n=== Type-mismatch warnings (non-fatal) ===');
  for (const w of warnings) console.log('  WARN  ' + w);
}

if (errors.length === 0) {
  console.log(
    `\nschema in sync: ${tablesScanned} Drizzle tables, ${dbTableCount} DB tables, ${warnings.length} warning(s)\n`,
  );
  process.exit(0);
}

console.error('\n=== Drift detected ===');
for (const e of errors) console.error('  ERR   ' + e);
console.error(
  `\n${errors.length} drift item(s). ${tablesScanned} Drizzle tables, ${dbTableCount} DB tables.\n` +
    `Write a new migration file in infra/postgres/migrations/ to fix.\n`,
);
process.exit(1);
} // end runDriftCheck
