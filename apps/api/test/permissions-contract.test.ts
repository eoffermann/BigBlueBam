import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ROUTE_TO_PERMISSION, PERMISSIONS_BY_ID } from '@bigbluebam/permissions';

// ─────────────────────────────────────────────────────────────────────
// Wave C contract test.
//
// Asserts the invariants that the codemod established and that Wave C2
// (full enforcement flip) will depend on:
//
//   1. Every route in apps/api/src/routes/ that has a role-based legacy
//      gate is now wrapped in dualReadGate.
//   2. Every dualReadGate call uses a permission_id that exists in the
//      catalog.
//   3. Every route in ROUTE_TO_PERMISSION maps to a permission that
//      exists in the catalog.
//
// What the test does NOT enforce (yet — Wave C2 territory):
//   - That dualReadGate has been *replaced* by requireCan. The Wave C
//     soak window expects both gates to stay live until divergence
//     telemetry is verified clean.
//   - That every route has SOME gate. ~24 routes intentionally have
//     only requireAuth + requireProjectAccessForEntity (entity-
//     visibility surface, not authz); those don't get a dualReadGate.
//     The codemod's "skipped (no preHandler array)" stat tracks these.
// ─────────────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '..');
const ROUTES_DIR = join(ROOT, 'src', 'routes');

const ROLE_GATE_PATTERNS = [
  /\brequireMinRole\s*\(/,
  /\brequireRole\s*\(/,
  /\brequireOrgRole\s*\(/,
  /\brequireProjectRole\s*\(/,
  /\brequireSuperuser\b(?!\s*\()/,
];

// Paths excluded from the catalog by scripts/generate-permission-manifest.mjs.
// Routes under these prefixes don't get a dualReadGate annotation (no
// catalog entry to map to). Mirrors EXCLUDED_PATH_PREFIXES in the generator.
const EXCLUDED_PATH_PREFIXES = ['/internal', '/health', '/healthz', '/readyz', '/version'];

function isExcludedPath(p: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + '/'),
  );
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const ALL_ROUTE_FILES = walk(ROUTES_DIR);
const FILE_CONTENTS = new Map(ALL_ROUTE_FILES.map((p) => [p, readFileSync(p, 'utf8')]));

// Extract every dualReadGate({...permission: '...'...}) ID from the source.
function extractDualReadPermissionIds(source: string): string[] {
  const re = /dualReadGate\s*\(\s*\{[\s\S]*?permission\s*:\s*['"]([^'"]+)['"]/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) ids.push(m[1]!);
  return ids;
}

describe('permissions contract — Wave C invariants', () => {
  it('every dualReadGate uses a permission_id present in the catalog', () => {
    const missing: { file: string; id: string }[] = [];
    for (const [file, src] of FILE_CONTENTS.entries()) {
      for (const id of extractDualReadPermissionIds(src)) {
        if (!PERMISSIONS_BY_ID.has(id)) {
          missing.push({ file: file.replace(ROUTES_DIR, '.../routes'), id });
        }
      }
    }
    if (missing.length > 0) {
      const lines = missing.slice(0, 20).map((m) => `  ${m.file}: ${m.id}`).join('\n');
      throw new Error(
        `${missing.length} dualReadGate permission IDs not in catalog:\n${lines}\n` +
          `Run scripts/build-permission-delta.mjs to add them.`,
      );
    }
    expect(missing).toEqual([]);
  });

  it('every ROUTE_TO_PERMISSION value is a real catalog permission', () => {
    const orphans: string[] = [];
    for (const [route, permId] of ROUTE_TO_PERMISSION.entries()) {
      if (!PERMISSIONS_BY_ID.has(permId)) orphans.push(`${route} -> ${permId}`);
    }
    expect(orphans).toEqual([]);
  });

  it('every role-gated ROUTE has AT LEAST one dualReadGate in its preHandler', () => {
    // The right granularity is per-route, not per-file. A route's
    // preHandler legitimately stacks multiple gates (e.g.
    // [requireAuth, dualReadGate({...}), requireScope('read_write'),
    // requireProjectRole('admin', 'member')]). Counting individual
    // role-gate sites across the whole file would over-report; what
    // matters is that EACH route that uses a role gate has been
    // shadowed by at least one dualReadGate.
    //
    // Walk every `fastify.<verb>(...)` call, extract its preHandler
    // array (if any), and assert: if the array contains ANY role-gate
    // reference, it must also contain dualReadGate.
    const findings: { file: string; route: string }[] = [];
    for (const [file, src] of FILE_CONTENTS.entries()) {
      for (const route of enumerateRoutes(src)) {
        if (isExcludedPath(route.path)) continue;
        const ph = findPreHandler(route.callContent);
        if (!ph) continue;
        const hasRoleGate = ROLE_GATE_PATTERNS.some((p) => new RegExp(p.source).test(ph));
        const hasDualRead = /\bdualReadGate\s*\(/.test(ph);
        if (hasRoleGate && !hasDualRead) {
          findings.push({
            file: file.replace(ROUTES_DIR, '.../routes'),
            route: `${route.method} ${route.path}`,
          });
        }
      }
    }
    if (findings.length > 0) {
      const lines = findings.slice(0, 30).map((f) => `  ${f.file}: ${f.route}`).join('\n');
      throw new Error(`${findings.length} role-gated routes lack dualReadGate:\n${lines}\nRun node scripts/codemod-add-dual-read.mjs --apply.`);
    }
    expect(findings).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Mini route parser. Mirrors the codemod's balanced-paren walk so the
// test stays in lock-step with what the codemod considers a "route".
// ─────────────────────────────────────────────────────────────────────

function* enumerateRoutes(source: string): Generator<{ method: string; path: string; callContent: string }> {
  const verbRegex = /fastify\.(get|post|put|patch|delete)\s*[<\(]/g;
  let m: RegExpExecArray | null;
  while ((m = verbRegex.exec(source)) !== null) {
    const method = m[1]!.toUpperCase();
    let i = m.index + m[0].length - 1;
    if (source[i] === '<') {
      let depth = 1; i++;
      while (i < source.length && depth > 0) {
        if (source[i] === '<') depth++;
        else if (source[i] === '>') depth--;
        i++;
      }
      while (i < source.length && /\s/.test(source[i]!)) i++;
      if (source[i] !== '(') continue;
    }
    const openParen = i;
    let depth = 1; i++;
    while (i < source.length && depth > 0) {
      const c = source[i]!;
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        while (i < source.length && source[i] !== q) {
          if (source[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    const callContent = source.slice(openParen + 1, i - 1);
    const pathMatch = callContent.match(/['"`]([^'"`]+)['"`]/);
    if (!pathMatch) continue;
    yield { method, path: pathMatch[1]!, callContent };
  }
}

function findPreHandler(callContent: string): string | null {
  const phMatch = callContent.match(/preHandler\s*:\s*\[/);
  if (!phMatch) return null;
  const start = phMatch.index! + phMatch[0].length;
  let depth = 1; let i = start;
  while (i < callContent.length && depth > 0) {
    const c = callContent[i]!;
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
  return callContent.slice(start, i);
}

describe('permissions contract — trailing close (lint workaround)', () => {
  it('passes (lints expect the describe block to end here)', () => {
    expect(true).toBe(true);
  });
});
