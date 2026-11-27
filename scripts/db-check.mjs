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
 * Single-column foreign keys are compared too (issue #160): a Drizzle
 * `.references()` the database does not enforce, a different target, or an
 * explicit `onDelete` that differs from the database fails the build. A
 * database FK Drizzle leaves out, or an `onDelete` Drizzle leaves out, is a
 * warning. See diffForeignKeys.
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

function parseSchemaFile(filePath, root) {
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
    /** @type {{sqlName: string, jsKey: string, line: number, idx: number}[]} */
    const colStarts = [];
    for (let i = 0; i < lines.length; i++) {
      const cm = lines[i].match(COLUMN_RE);
      if (!cm) continue;
      const jsKey = cm[1];
      const builderName = cm[2];
      const sqlName = cm[3] ?? jsKey;
      // Skip things that look like nested callbacks / non-column helpers.
      if (builderName === 'sql' || builderName === 'index') continue;
      colStarts.push({ sqlName, jsKey, line: startLine + i, idx: i });
      if (!existing.columns.has(sqlName)) {
        existing.columns.set(sqlName, {
          name: sqlName,
          drizzleType: builderName,
          file: relPath,
          line: startLine + i,
        });
      }
    }

    // Foreign keys (issue #160): a column's builder chain runs from its own
    // line to the next column's line; a `.references(() => table.col, {...})`
    // inside it is a declared single-column FK.
    for (let k = 0; k < colStarts.length; k++) {
      const c = colStarts[k];
      const end = k + 1 < colStarts.length ? colStarts[k + 1].idx : lines.length;
      const chain = lines.slice(c.idx, end).join('\n');
      const fk = parseReferences(chain);
      if (fk) {
        drizzleForeignKeys.push({
          table: tableName,
          column: c.sqlName,
          refVar: fk.refVar,
          refKey: fk.refKey,
          onDelete: fk.onDelete,
          onDeleteExplicit: fk.onDeleteExplicit,
          root,
          file: relPath,
          line: c.line,
        });
      }
    }

    drizzleTables.set(tableName, existing);
  }
}

/**
 * The single-column FK declared in one Drizzle column builder chain, or null.
 * Exported for scripts/db-check.fk.test.mjs.
 * @param {string} chain
 * @returns {{refVar: string, refKey: string, onDelete: string} | null}
 */
export function parseReferences(chain) {
  const m = /\.references\(\s*\(\s*\)\s*(?::\s*[A-Za-z_][A-Za-z0-9_]*\s*)?=>\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/.exec(
    chain,
  );
  if (!m) return null;
  const rest = chain.slice(m.index);
  // The options object, if any, sits between the target and the call's closing paren.
  const close = rest.indexOf(')', m[0].length);
  const od = /onDelete:\s*['"`]([a-z ]+)['"`]/.exec(close === -1 ? rest : rest.slice(0, close));
  return { refVar: m[1], refKey: m[2], onDelete: od ? od[1] : 'no action', onDeleteExplicit: !!od };
}

/**
 * Maps a Drizzle table variable to its SQL table name and its column keys to
 * SQL column names. Built per schema root first (a variable name means the
 * table its own app declares), then globally as a fallback for refs stubs.
 */
/** @type {Map<string, Map<string, {table: string, keys: Map<string, string>}>>} */
const tableVarsByRoot = new Map();

function collectTableVars(root, filePath) {
  const src = readFileSync(filePath, 'utf8');
  const re = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*pgTable\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;
  let m;
  let vars = tableVarsByRoot.get(root);
  if (!vars) {
    vars = new Map();
    tableVarsByRoot.set(root, vars);
  }
  while ((m = re.exec(src)) !== null) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = matchBrace(src, braceOpen);
    const keys = new Map();
    if (braceClose !== -1) {
      for (const line of src.slice(braceOpen + 1, braceClose).split('\n')) {
        const cm = line.match(COLUMN_RE);
        if (cm && cm[2] !== 'sql' && cm[2] !== 'index') keys.set(cm[1], cm[3] ?? cm[1]);
      }
    }
    vars.set(m[1], { table: m[2], keys });
  }
}

/** @type {Array<{table: string, column: string, refVar: string, refKey: string, onDelete: string, root: string, file: string, line: number}>} */
const drizzleForeignKeys = [];

/**
 * Several schema roots can declare the same table (an app's own table plus the
 * reference stubs other apps keep of it), so one FK can be declared more than
 * once. Merge them (issue #360): an explicit onDelete beats an omitted one, so
 * a stub that leaves onDelete out cannot mask the owning schema's declaration,
 * and two declarations that disagree on the target or on an explicit onDelete
 * are reported as conflicts. Pure; exported for scripts/lib/db-check-fk.test.mjs.
 * @param {Array<{key: string, refTable: string, refColumn: string, onDelete: string, onDeleteExplicit: boolean, file?: string, line?: number}>} decls
 */
export function mergeForeignKeyDeclarations(decls) {
  const declared = new Map();
  const conflicts = [];
  for (const d of decls) {
    const { key, ...fk } = d;
    const prev = declared.get(key);
    if (!prev) {
      declared.set(key, fk);
      continue;
    }
    const targetDiffers = prev.refTable !== fk.refTable || prev.refColumn !== fk.refColumn;
    const onDeleteDiffers = prev.onDeleteExplicit && fk.onDeleteExplicit && prev.onDelete !== fk.onDelete;
    if (targetDiffers || onDeleteDiffers) {
      conflicts.push(
        `CONFLICTING FOREIGN KEY DECLARATIONS: ${key}: ${prev.file}:${prev.line} -> ${prev.refTable}.${prev.refColumn} (on delete ${prev.onDelete}), ` +
          `${fk.file}:${fk.line} -> ${fk.refTable}.${fk.refColumn} (on delete ${fk.onDelete})\n` +
          `  fix: make every schema that declares ${key} agree with the database.`,
      );
      continue;
    }
    if (!prev.onDeleteExplicit && fk.onDeleteExplicit) declared.set(key, fk);
  }
  return { declared, conflicts };
}

/** Resolve each declared FK's table variable to SQL names (own root first, then any root). */
function resolveDrizzleForeignKeys() {
  /** @type {Array<{key: string, refTable: string, refColumn: string, onDelete: string, onDeleteExplicit: boolean, file: string, line: number}>} */
  const out = [];
  for (const fk of drizzleForeignKeys) {
    let target = tableVarsByRoot.get(fk.root)?.get(fk.refVar);
    if (!target) {
      for (const vars of tableVarsByRoot.values()) {
        if (vars.has(fk.refVar)) {
          target = vars.get(fk.refVar);
          break;
        }
      }
    }
    if (!target) continue; // unresolvable variable: nothing to compare
    out.push({
      key: `${fk.table}.${fk.column}`,
      refTable: target.table,
      refColumn: target.keys.get(fk.refKey) ?? fk.refKey,
      onDelete: fk.onDelete,
      onDeleteExplicit: fk.onDeleteExplicit,
      file: fk.file,
      line: fk.line,
    });
  }
  return mergeForeignKeyDeclarations(out);
}

/**
 * Database FKs no Drizzle schema can declare, each with the reviewed reason
 * (issue #360). Keep this list short: the normal fix for an undeclared FK is a
 * `.references()` (use `(): AnyPgColumn => table.id` for self and circular
 * references). An entry whose FK is gone from the database, or that Drizzle now
 * declares, is an error, so the list cannot rot.
 */
export const UNDECLARED_FK_ALLOWLIST = {
  'bench_widgets.basis_metric_id':
    'cross-product reference into Basis (migration 0228); bench-api declares no basis_metrics table and its code only stores the id',
};

/**
 * Compare declared and live single-column FKs. Pure; exported for
 * scripts/db-check.fk.test.mjs.
 *   - declared in Drizzle, absent in the DB: error (code relies on a constraint
 *     nothing enforces; the #160 class)
 *   - same FK, different referenced table: error
 *   - an explicit Drizzle onDelete that differs from the DB: error
 *   - Drizzle left onDelete out but the DB has one: warning (the declaration
 *     is incomplete, the database is still enforcing something)
 *   - present in the DB, not declared (many are deliberate: self-references and
 *     circular imports the schema files leave out): warning
 * @param {Map<string, {refTable: string, refColumn: string, onDelete: string, onDeleteExplicit?: boolean, file?: string, line?: number}>} declared
 * @param {Map<string, {refTable: string, refColumn: string, onDelete: string}>} live
 * @param {Map<string, unknown>} declaredTables  tables Drizzle knows (a DB FK on an unknown table is reported as an unknown table already)
 * @param {Record<string, string>} allowlist  undeclared DB FKs accepted on purpose (UNDECLARED_FK_ALLOWLIST)
 */
export function diffForeignKeys(declared, live, declaredTables, allowlist = {}) {
  const errors = [];
  const warnings = [];
  for (const [key, d] of declared) {
    const where = d.file ? `  declared at: ${d.file}:${d.line}\n` : '';
    const l = live.get(key);
    if (!l) {
      errors.push(
        `MISSING FOREIGN KEY in DB: ${key} -> ${d.refTable}.${d.refColumn} (on delete ${d.onDelete})\n` +
          where +
          `  fix: add the constraint in a migration, or (if the database cannot enforce it, e.g. it references a partitioned table) drop the .references() and say what enforces it instead.`,
      );
      continue;
    }
    if (l.refTable !== d.refTable || l.refColumn !== d.refColumn) {
      errors.push(
        `FOREIGN KEY TARGET MISMATCH: ${key}: Drizzle -> ${d.refTable}.${d.refColumn}, DB -> ${l.refTable}.${l.refColumn}\n` + where,
      );
    } else if (l.onDelete !== d.onDelete) {
      const msg = `FOREIGN KEY ON DELETE MISMATCH: ${key} -> ${d.refTable}: Drizzle "${d.onDelete}"${
        d.onDeleteExplicit === false ? ' (onDelete not declared)' : ''
      }, DB "${l.onDelete}"\n${where}`;
      if (d.onDeleteExplicit === false) warnings.push(msg);
      else errors.push(msg);
    }
  }
  for (const key of Object.keys(allowlist)) {
    if (!live.has(key)) {
      errors.push(`STALE FK ALLOWLIST ENTRY: ${key} is in UNDECLARED_FK_ALLOWLIST but the database has no such FK; remove the entry.`);
    } else if (declared.has(key)) {
      errors.push(`STALE FK ALLOWLIST ENTRY: ${key} is in UNDECLARED_FK_ALLOWLIST but Drizzle now declares it; remove the entry.`);
    }
  }
  for (const [key, l] of live) {
    if (declared.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, key)) continue;
    const table = key.slice(0, key.indexOf('.'));
    if (!declaredTables.has(table)) continue;
    warnings.push(
      `UNDECLARED FOREIGN KEY in DB: ${key} -> ${l.refTable}.${l.refColumn} (on delete ${l.onDelete}): no Drizzle .references() declares it.\n` +
        `  fix: add .references(() => ..., { onDelete: '${l.onDelete}' }) to the column.`,
    );
  }
  return { errors, warnings };
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
    for (const f of walkTsFiles(root)) collectTableVars(root, f);
  }
  for (const root of SCHEMA_ROOTS) {
    for (const f of walkTsFiles(root)) parseSchemaFile(f, root);
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
/** @type {Map<string, {refTable: string, refColumn: string, onDelete: string}>} keyed "table.column" */
const dbForeignKeys = new Map();

try {
  // Join to pg_class so we can filter out:
  //   - partition children (they inherit columns from the parent, which is
  //     already declared in Drizzle as a single pgTable; Drizzle does not
  //     need a per-month `banter_messages_2026_04` declaration);
  //   - views and materialized views (pg_class.relkind in ('v','m'), not
  //     declared via pgTable).
  // We keep:
  //   - ordinary tables (relkind = 'r')
  //   - partitioned parents (relkind = 'p')
  //   - non-partition children of those parents (relispartition = false)
  const rows = await sql`
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN pg_class pc ON pc.relname = c.table_name
    JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE c.table_schema = 'public'
      AND pn.nspname = 'public'
      AND pc.relkind IN ('r', 'p')
      AND NOT pc.relispartition
    ORDER BY c.table_name, c.ordinal_position
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
  // Single-column foreign keys (issue #160). conparentid = 0 keeps the FK
  // declared on a partitioned parent and drops the copies Postgres clones
  // onto each partition.
  const fkRows = await sql`
    SELECT src.relname AS table_name, a.attname AS column_name,
           dst.relname AS ref_table, af.attname AS ref_column,
           CASE con.confdeltype
             WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
             WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default' END AS on_delete
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = src.relnamespace
    JOIN pg_class dst ON dst.oid = con.confrelid
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = con.confkey[1]
    WHERE con.contype = 'f'
      AND ns.nspname = 'public'
      AND cardinality(con.conkey) = 1
      AND con.conparentid = 0
      AND NOT src.relispartition
  `;
  for (const r of fkRows) {
    if (DB_IGNORE_TABLES.has(r.table_name)) continue;
    dbForeignKeys.set(`${r.table_name}.${r.column_name}`, {
      refTable: r.ref_table,
      refColumn: r.ref_column,
      onDelete: r.on_delete,
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

// Foreign keys (issue #160). A Drizzle `.references()` the database does not
// enforce is drift: code relying on its ON DELETE (e.g. a cascade) silently
// leaves orphans. Both directions are reported.
const fkDecls = resolveDrizzleForeignKeys();
errors.push(...fkDecls.conflicts);
const fkDiff = diffForeignKeys(fkDecls.declared, dbForeignKeys, drizzleTables, UNDECLARED_FK_ALLOWLIST);
errors.push(...fkDiff.errors);
warnings.push(...fkDiff.warnings);

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
