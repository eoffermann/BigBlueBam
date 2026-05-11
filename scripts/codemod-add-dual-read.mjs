#!/usr/bin/env node
//
// Wave C codemod: wrap every legacy gate in apps/api/src/routes/ with a
// dualReadGate so the resolver shadows on EVERY request, not just the 7
// sample routes Wave B annotated by hand. Does NOT remove the legacy
// gate — Wave C2 will switch to pure requireCan() after the soak proves
// divergence stays at zero.
//
// Strategy:
//   - For each route declaration `fastify.<verb>('<path>', { preHandler:
//     [..., requireMinRole('X'), ...] }, ...)`, replace the role gate
//     call with `dualReadGate({ legacy: requireMinRole('X'), permission:
//     '<id from catalog>' })` using ROUTE_TO_PERMISSION lookup.
//   - Add `import { dualReadGate } from '../middleware/dual-read.js';`
//     once per file if at least one site got wrapped.
//   - Patterns wrapped: requireMinRole, requireRole, requireOrgRole,
//     requireProjectRole, requireSuperuser.
//   - Pattern NOT wrapped: requireScope (api-key ceiling, kept separate),
//     requireAuth (no role decision), requireProjectAccess /
//     requireProjectAccessForEntity (entity-visibility, not authz).
//   - Sites already wrapped (the 7 Wave B samples) are skipped.
//   - Routes whose method+path don't appear in ROUTE_TO_PERMISSION are
//     reported as unmapped; operator decides whether to add a manifest
//     entry or skip.
//
// Run mode:
//   --dry-run    print what would change, write nothing
//   --apply      actually rewrite files
//
// Files affected: apps/api/src/routes/*.ts. Each file's diff is
// human-reviewable by `git diff` before commit.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/'), '..');
const ROUTES_DIR = join(ROOT, 'apps/api/src/routes');
const TS_PATH = join(ROOT, 'packages/permissions/src/generated/permissions.ts');

const APPLY = process.argv.includes('--apply');

// Load the route → permission map from the generated TS. Parse the
// `ROUTE_TO_PERMISSION` const directly to avoid a build dependency.
function loadRouteToPermission() {
  const text = readFileSync(TS_PATH, 'utf8');
  const start = text.indexOf('ROUTE_TO_PERMISSION');
  if (start < 0) throw new Error('ROUTE_TO_PERMISSION not found in generated TS');
  const map = new Map();
  // Each entry: [ "GET /foo", "bam.foo.list" ],
  const re = /\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g;
  const block = text.slice(start);
  let m;
  while ((m = re.exec(block)) !== null) {
    map.set(m[1], m[2]);
    if (block.slice(m.index).indexOf(']);') < 50) break; // end of map
  }
  return map;
}

// ── Route-declaration parser ─────────────────────────────────────────
//
// Match `fastify.<verb>('<path>', { preHandler: [...] }, handler)` or
// `fastify.<verb><...>(`...same.... Find the preHandler array and the
// path string. Handles multi-line declarations.

function* enumerateRoutes(source) {
  // We look for `fastify.METHOD` (optionally with `<...>` type args), then
  // `(`, then the first string literal (the path), then somewhere in the
  // following options object: `preHandler: [...]`.
  //
  // Strategy: scan top-down for fastify.<method>, then walk balanced parens.
  const verbRegex = /fastify\.(get|post|put|patch|delete)\s*[<\(]/g;
  let m;
  while ((m = verbRegex.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    // Move forward past `<...>` type args if present, then to `(`.
    let i = m.index + m[0].length - 1; // either `<` or `(`
    if (source[i] === '<') {
      // skip <...> balanced
      let depth = 1; i++;
      while (i < source.length && depth > 0) {
        if (source[i] === '<') depth++;
        else if (source[i] === '>') depth--;
        i++;
      }
      // skip whitespace
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] !== '(') continue;
    }
    // Now i is the `(`. Walk balanced parens to find the call's contents.
    const openParen = i;
    let depth = 1; i++;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === '"' || c === "'" || c === '`') {
        // skip string literal
        const q = c; i++;
        while (i < source.length && source[i] !== q) {
          if (source[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    const closeParen = i - 1;
    const callContent = source.slice(openParen + 1, closeParen);
    const pathMatch = callContent.match(/['"`]([^'"`]+)['"`]/);
    if (!pathMatch) continue;
    const path = pathMatch[1];
    yield { method, path, openParen, closeParen, callContent };
  }
}

function findPreHandlerArray(callContent, callOffset) {
  // Look for `preHandler:` then the `[ ... ]` array. We need the offsets
  // in the source for replacement.
  const phMatch = callContent.match(/preHandler\s*:\s*\[/);
  if (!phMatch) return null;
  const startIdx = phMatch.index + phMatch[0].length;
  // Walk balanced brackets to find end of array.
  let depth = 1;
  let i = startIdx;
  while (i < callContent.length && depth > 0) {
    const c = callContent[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < callContent.length && callContent[i] !== q) {
        if (callContent[i] === '\\') i++;
        i++;
      }
    }
    if (depth === 0) break;
    i++;
  }
  const endIdx = i; // points at the `]`
  const arrayContent = callContent.slice(startIdx, endIdx);
  return {
    arrayContent,
    absoluteStart: callOffset + 1 + startIdx,
    absoluteEnd: callOffset + 1 + endIdx,
  };
}

// ── Gate matchers ────────────────────────────────────────────────────
//
// We replace any of these call forms with dualReadGate wrapping the
// original. Order matters: most specific first.

const GATE_PATTERNS = [
  // requireMinRole('admin')
  { name: 'requireMinRole', regex: /\brequireMinRole\s*\(\s*['"][^'"]+['"]\s*\)/g },
  // requireRole(['owner', 'admin'])
  { name: 'requireRole', regex: /\brequireRole\s*\(\s*\[[^\]]+\]\s*\)/g },
  // requireOrgRole('admin', 'owner') or requireOrgRole(['admin','owner'])
  { name: 'requireOrgRole', regex: /\brequireOrgRole\s*\(\s*[^)]+\)/g },
  // requireProjectRole('admin', 'member')
  { name: 'requireProjectRole', regex: /\brequireProjectRole\s*\(\s*[^)]+\)/g },
  // requireSuperuser  (no args — it's a const preHandler)
  { name: 'requireSuperuser', regex: /\brequireSuperuser\b(?!\s*\()/g },
];

function transformPreHandler(arrayContent, permissionId) {
  // Skip the route entirely if the preHandler array already contains a
  // dualReadGate (either from a previous codemod run or hand-annotated
  // in Wave B). Re-wrapping would create dualReadGate({legacy:
  // dualReadGate({legacy: requireX(...)})...}), which is the bug the
  // earlier 20-char-window check missed when the original dualReadGate
  // call spans multiple lines.
  if (arrayContent.includes('dualReadGate')) return null;

  // For each gate pattern, replace the FIRST match with the wrapped
  // form. Only one replacement per array (because each route's
  // permission is one ID — wrapping multiple gates with the same
  // permission would just double-report).
  for (const pat of GATE_PATTERNS) {
    pat.regex.lastIndex = 0;
    const m = pat.regex.exec(arrayContent);
    if (m) {
      const before = arrayContent.slice(0, m.index);
      const after = arrayContent.slice(m.index + m[0].length);
      const wrapped = `dualReadGate({ legacy: ${m[0]}, permission: '${permissionId}' })`;
      return { newContent: before + wrapped + after, wrappedGate: pat.name };
    }
  }
  return null;
}

function ensureImport(source) {
  if (source.includes("from '../middleware/dual-read.js'")) return source;
  // Find the last import line in the file and insert after it.
  const lines = source.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i])) lastImport = i;
  }
  if (lastImport < 0) {
    // No imports? Prepend.
    return `import { dualReadGate } from '../middleware/dual-read.js';\n` + source;
  }
  lines.splice(lastImport + 1, 0, `import { dualReadGate } from '../middleware/dual-read.js';`);
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────

function processFile(path, routeMap, stats) {
  const original = readFileSync(path, 'utf8');
  let source = original;
  // We rewrite from the end so earlier offsets stay valid.
  const routesInFile = [...enumerateRoutes(source)];
  // Sort descending by openParen so substitutions don't shift offsets.
  routesInFile.sort((a, b) => b.openParen - a.openParen);

  let touched = false;
  for (const r of routesInFile) {
    const key = `${r.method} ${r.path}`;
    const permissionId = routeMap.get(key);
    if (!permissionId) {
      stats.unmapped.push({ file: basename(path), method: r.method, path: r.path });
      continue;
    }
    const ph = findPreHandlerArray(r.callContent, r.openParen);
    if (!ph) {
      // No preHandler array — route relies on Fastify defaults; we can't
      // safely add one mechanically without changing call shape. Skip.
      stats.skippedNoPreHandler++;
      continue;
    }
    const xform = transformPreHandler(ph.arrayContent, permissionId);
    if (!xform) {
      stats.skippedAlreadyWrappedOrNoGate++;
      continue;
    }
    source = source.slice(0, ph.absoluteStart) + xform.newContent + source.slice(ph.absoluteEnd);
    stats.wrapped++;
    stats.perPattern[xform.wrappedGate] = (stats.perPattern[xform.wrappedGate] ?? 0) + 1;
    touched = true;
  }

  if (touched) {
    source = ensureImport(source);
    if (APPLY) {
      writeFileSync(path, source);
    }
    stats.touchedFiles.push(basename(path));
  }
}

function main() {
  const routeMap = loadRouteToPermission();
  console.log(`Loaded ${routeMap.size} route→permission mappings.`);

  const stats = {
    wrapped: 0,
    skippedAlreadyWrappedOrNoGate: 0,
    skippedNoPreHandler: 0,
    perPattern: {},
    unmapped: [],
    touchedFiles: [],
  };

  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) processFile(p, routeMap, stats);
    }
  }
  walk(ROUTES_DIR);

  console.log('');
  console.log(`Files touched: ${stats.touchedFiles.length}`);
  console.log(`Wrappings:     ${stats.wrapped}`);
  console.log(`  by pattern:`);
  for (const [k, v] of Object.entries(stats.perPattern)) {
    console.log(`    ${k.padEnd(20)} ${v}`);
  }
  console.log(`Skipped (already wrapped / no gate): ${stats.skippedAlreadyWrappedOrNoGate}`);
  console.log(`Skipped (no preHandler array):       ${stats.skippedNoPreHandler}`);
  console.log(`Unmapped routes:                      ${stats.unmapped.length}`);
  if (stats.unmapped.length > 0) {
    for (const u of stats.unmapped.slice(0, 20)) {
      console.log(`  ${u.method.padEnd(7)} ${u.path}  (${u.file})`);
    }
    if (stats.unmapped.length > 20) console.log(`  ... and ${stats.unmapped.length - 20} more`);
  }
  if (!APPLY) {
    console.log('');
    console.log('(dry run — pass --apply to write changes)');
  }
}

main();
