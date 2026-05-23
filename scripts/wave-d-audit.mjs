#!/usr/bin/env node
// Wave D per-action permission audit for apps/api.
// Read-only: emits a JSON summary on stdout.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(REPO, 'apps/api/src/routes');
const MANIFEST = path.join(REPO, 'docs/permissions-action-manifest.json');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// Build set of route files actually present
const routeFiles = new Set(fs.readdirSync(ROUTES_DIR));

// Filter in-scope manifest entries.
// Per audit brief: include any permission with source.source=='rest' whose file basename
// matches a file in apps/api/src/routes/. Permission `app` may be 'bam', 'platform',
// 'shared', or a sub-app whose route file happens to share a basename with an apps/api file.
// We later filter MISSING_ROUTE entries from foreign-app collisions (e.g. 'brief.comment.*'
// hitting apps/api/comment.routes.ts) using a second pass: if app is not in
// {bam, platform, shared} AND no matching route exists in apps/api, treat as OUT_OF_SCOPE.
const inScopeRaw = [];
for (const p of manifest.permissions) {
  for (const s of (p.sources || [])) {
    if (s.source !== 'rest') continue;
    const base = path.basename(s.file);
    if (!routeFiles.has(base)) continue;
    inScopeRaw.push({
      id: p.id,
      app: p.app,
      is_destructive: !!p.is_destructive,
      is_read: !!p.is_read,
      requires_superuser: !!p.requires_superuser,
      requires_confirmation: !!p.requires_confirmation,
      method: s.ref.split(/\s+/)[0].toUpperCase(),
      path: s.ref.split(/\s+/).slice(1).join(' '),
      file: base,
    });
  }
}
const inScope = inScopeRaw;

// Map: file -> array of { method, path, line, preHandlerText, lineEnd }
// We parse fastify.<verb>(...) declarations by reading each file as text.
// Approach: regex for fastify.(get|post|put|patch|delete) and then capture the
// route string literal (first arg) + the options object (preHandler section).

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function parseFastifyRoutes(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split('\n');
  // Find every fastify.<verb>( occurrence
  const routes = [];
  const verbRe = /fastify\.(get|post|put|patch|delete|options|head)\s*(?:<[^>]*(?:<[^>]*>[^>]*)?>)?\s*\(/g;
  let m;
  while ((m = verbRe.exec(txt)) !== null) {
    const method = m[1].toUpperCase();
    // Position just after the opening paren of the call.
    const callStart = m.index + m[0].length;
    // Walk paren-balanced to find call end
    let depth = 1;
    let i = callStart;
    let inStr = null;
    let inTpl = false;
    let inLineCmt = false;
    let inBlockCmt = false;
    while (i < txt.length && depth > 0) {
      const c = txt[i];
      const nx = txt[i+1];
      if (inLineCmt) {
        if (c === '\n') inLineCmt = false;
        i++; continue;
      }
      if (inBlockCmt) {
        if (c === '*' && nx === '/') { inBlockCmt = false; i += 2; continue; }
        i++; continue;
      }
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === inStr) { inStr = null; i++; continue; }
        i++; continue;
      }
      if (inTpl) {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { inTpl = false; i++; continue; }
        // template literal interpolation handling skipped (rare in route paths)
        i++; continue;
      }
      if (c === '/' && nx === '/') { inLineCmt = true; i += 2; continue; }
      if (c === '/' && nx === '*') { inBlockCmt = true; i += 2; continue; }
      if (c === '"' || c === "'") { inStr = c; i++; continue; }
      if (c === '`') { inTpl = true; i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const callEnd = i; // position just past closing paren
    const callBody = txt.slice(callStart, callEnd - 1);
    // Parse path: extract first string literal
    const pathMatch = callBody.match(/^[\s\n]*['"`]([^'"`]+)['"`]/);
    if (!pathMatch) continue;
    const routePath = pathMatch[1];
    // Find preHandler text
    // Look for `preHandler:` followed by an array (or single)
    const preHandlerText = extractPreHandler(callBody);
    // Compute line of the fastify.verb
    const lineNo = txt.slice(0, m.index).split('\n').length;
    routes.push({ method, path: routePath, line: lineNo, preHandlerText });
  }
  return routes;
}

function extractPreHandler(callBody) {
  const idx = callBody.indexOf('preHandler');
  if (idx < 0) return null;
  // Find colon after
  let i = idx + 'preHandler'.length;
  while (i < callBody.length && /\s/.test(callBody[i])) i++;
  if (callBody[i] !== ':') return null;
  i++;
  while (i < callBody.length && /\s/.test(callBody[i])) i++;
  // Capture either array [...] or single expression up to comma at depth 0
  if (callBody[i] === '[') {
    let depth = 1;
    const start = i;
    i++;
    let inStr = null, inTpl = false;
    while (i < callBody.length && depth > 0) {
      const c = callBody[i], nx = callBody[i+1];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === inStr) inStr = null;
        i++; continue;
      }
      if (inTpl) {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') inTpl = false;
        i++; continue;
      }
      if (c === '"' || c === "'") { inStr = c; i++; continue; }
      if (c === '`') { inTpl = true; i++; continue; }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      i++;
    }
    return callBody.slice(start, i);
  }
  // Else single expression — read until top-level comma or end
  const start = i;
  let depth = 0;
  let inStr = null, inTpl = false;
  while (i < callBody.length) {
    const c = callBody[i], nx = callBody[i+1];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (inTpl) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') inTpl = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = c; i++; continue; }
    if (c === '`') { inTpl = true; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) break;
    i++;
  }
  return callBody.slice(start, i);
}

// Parse all in-scope route files
const fileRoutes = {};
const filesInScope = new Set(inScope.map(e => e.file));
for (const f of filesInScope) {
  const fp = path.join(ROUTES_DIR, f);
  fileRoutes[f] = parseFastifyRoutes(fp);
}

// Path normalization. Manifest refs may have e.g. "POST /v1/projects/:id"
// but routes typically use "/projects/:id". superuser.routes.ts is registered
// with prefix "/superuser". internal-helpdesk.routes.ts with prefix
// "/internal/helpdesk". internal-llm.routes.ts with prefix "/internal/llm".
// We try multiple candidate normalizations.

const PREFIX_BY_FILE = {
  'superuser.routes.ts': '/superuser',
  'internal-helpdesk.routes.ts': '/internal/helpdesk',
  'internal-llm.routes.ts': '/internal/llm',
};

function candidatesForManifestPath(file, p) {
  const cands = new Set();
  let raw = p;
  cands.add(raw);
  // Strip /v1
  if (raw.startsWith('/v1/')) cands.add(raw.slice(3));
  if (raw === '/v1') cands.add('/');
  // Strip prefix for prefixed files
  const pref = PREFIX_BY_FILE[file];
  if (pref) {
    // Drop /v1 first
    let s = raw;
    if (s.startsWith('/v1')) s = s.slice(3);
    if (s.startsWith(pref + '/')) cands.add(s.slice(pref.length));
    if (s === pref) cands.add('/');
    // Sometimes manifest already excludes prefix; just keep s
    cands.add(s);
  }
  return [...cands];
}

function findMatchingRoute(file, manifestMethod, manifestPath) {
  const routes = fileRoutes[file] || [];
  const cands = candidatesForManifestPath(file, manifestPath);
  const candSet = new Set(cands);
  // Look for exact match
  for (const r of routes) {
    if (r.method !== manifestMethod) continue;
    if (candSet.has(r.path)) return r;
  }
  return null;
}

// Extract permission ID from preHandler text. Supports dualReadGate({ ..., permission: 'X' })
// and requireCan('X') and shadowOnly('X')
function gateInfo(preHandlerText) {
  if (!preHandlerText) return { kind: 'none', permission: null, raw: null };
  const out = { kind: 'none', permission: null, raw: null, all: [] };
  // dualReadGate
  const dual = [...preHandlerText.matchAll(/dualReadGate\s*\(\s*\{[\s\S]*?permission\s*:\s*['"]([^'"]+)['"]/g)];
  for (const d of dual) out.all.push({ kind: 'dualReadGate', permission: d[1] });
  const rc = [...preHandlerText.matchAll(/requireCan\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  for (const r of rc) out.all.push({ kind: 'requireCan', permission: r[1] });
  const so = [...preHandlerText.matchAll(/shadowOnly\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  for (const r of so) out.all.push({ kind: 'shadowOnly', permission: r[1] });
  // fastify.requireCan
  const frc = [...preHandlerText.matchAll(/fastify\.requireCan\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  for (const r of frc) out.all.push({ kind: 'requireCan', permission: r[1] });
  if (out.all.length) {
    out.kind = out.all[0].kind;
    out.permission = out.all[0].permission;
    out.raw = out.all.map(a => `${a.kind}(${a.permission})`).join('+');
  }
  return out;
}

function legacyGateInfo(preHandlerText) {
  if (!preHandlerText) return { hasLegacy: false, gates: [], hasSuperuserInline: false };
  const gates = [];
  for (const pat of ['requireMinRole', 'requireOrgRole', 'requireRole', 'requireSuperuser', 'requireProjectRole', 'requireSuperUser']) {
    const re = new RegExp(`\\b${pat}\\s*\\(`, 'g');
    if (re.test(preHandlerText)) gates.push(pat);
  }
  return { hasLegacy: gates.length > 0, gates };
}

// Run analysis
const APPS_ALWAYS_IN_SCOPE = new Set(['bam', 'platform', 'shared']);
const results = [];
const outOfScope = [];
for (const e of inScope) {
  const route = findMatchingRoute(e.file, e.method, e.path);
  if (!route) {
    // Foreign-app basename collision: drop from in-scope, classify as OUT_OF_SCOPE.
    if (!APPS_ALWAYS_IN_SCOPE.has(e.app)) {
      outOfScope.push({ ...e, reason: 'basename collision; route lives in apps/'+e.app+'-api' });
      continue;
    }
    results.push({
      ...e,
      classification: 'MISSING_ROUTE',
      route_line: null,
      gate_pattern: null,
      legacy_gates: null,
      notes: 'No matching route handler in code',
    });
    continue;
  }
  const g = gateInfo(route.preHandlerText);
  const legacy = legacyGateInfo(route.preHandlerText);
  // Inline superuser check inside the handler body would require parsing the handler too — we
  // approximate by looking at preHandler only. Note in classification when only legacy + no perm.
  let classification;
  if (g.kind === 'none') {
    classification = 'NO_GATE';
  } else if (g.permission === e.id) {
    classification = 'OK';
  } else {
    // Check if any of the gates matches
    const any = g.all.find(a => a.permission === e.id);
    if (any) classification = 'OK';
    else classification = 'MISMATCH';
  }
  results.push({
    ...e,
    classification,
    route_line: route.line,
    gate_pattern: g.raw,
    legacy_gates: legacy.gates.join(','),
    notes: classification === 'MISMATCH' ? `Found ${g.raw}, expected ${e.id}` :
           (classification === 'NO_GATE' && legacy.hasLegacy) ? `Has legacy gates: ${legacy.gates.join(',')} but no dualReadGate/requireCan` :
           (classification === 'NO_GATE') ? 'preHandler has no permission check' : '',
  });
}

// Detect INLINE_CHECK — look at preHandler-less routes that nonetheless reference is_superuser
// inside the handler body. We do a coarse second pass: read the function body of each NO_GATE
// route and look for `is_superuser` references early in it.
function handlerBodyOf(filePath, lineNo) {
  const txt = fs.readFileSync(filePath, 'utf8');
  // Slice from lineNo
  const lines = txt.split('\n');
  const slice = lines.slice(lineNo - 1, lineNo - 1 + 80).join('\n');
  return slice;
}

for (const r of results) {
  if (r.classification !== 'NO_GATE') continue;
  const body = handlerBodyOf(path.join(ROUTES_DIR, r.file), r.route_line);
  // Look for gating pattern only: `if (!...is_superuser...)` or `if (...is_superuser)` followed
  // soon by `reply.code(403)` or `return reply.status(`. Skip mere reads of the field for
  // response shaping.
  const hasGatingShape = /if\s*\([^)]*is_superuser[^)]*\)\s*[\s\S]{0,200}(reply\.(status|code)\s*\(\s*4(01|03)|FORBIDDEN|UNAUTHORIZED)/.test(body);
  if (hasGatingShape) {
    r.classification = 'INLINE_CHECK';
    r.notes = (r.notes || '') + ' | handler body has inline is_superuser gate';
  }
}

// Summary counts
const counts = { total: results.length, OK: 0, MISMATCH: 0, NO_GATE: 0, MISSING_ROUTE: 0, INLINE_CHECK: 0 };
for (const r of results) counts[r.classification]++;

// Per-file table
const perFile = {};
for (const r of results) {
  perFile[r.file] = perFile[r.file] || { expected: 0, OK: 0, MISMATCH: 0, NO_GATE: 0, MISSING_ROUTE: 0, INLINE_CHECK: 0 };
  perFile[r.file].expected++;
  perFile[r.file][r.classification]++;
}

// Output JSON
console.log(JSON.stringify({ counts, perFile, results, outOfScope }, null, 2));
