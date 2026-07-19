/**
 * Shared MCP tool-source parsing + the canonical app -> tool-module mapping.
 *
 * This is the single source of truth for "which tool source files back which
 * app" and for turning a `registerTool(server, { name, description, input })`
 * block into structured data. Both the docs extract stage
 * (scripts/docs/extract.mjs) and the marketing-site catalog generator
 * (scripts/docs/build-docs-catalog.mjs) import from here so the two never
 * drift apart.
 *
 * The app roster and ordering come from LAUNCHPAD_CATALOG in
 * apps/api/src/routes/system-settings.routes.ts (the runtime source of truth
 * for the app list). We read it out of the TypeScript source at run time via
 * readLaunchpadCatalog() rather than hardcoding it, so adding an app to the
 * Launchpad automatically flows into the generated docs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..', '..');

export const TOOLS_DIR = path.join(ROOT, 'apps', 'mcp-server', 'src', 'tools');
const SYS_SETTINGS = path.join(
  ROOT,
  'apps',
  'api',
  'src',
  'routes',
  'system-settings.routes.ts',
);

// ---------------------------------------------------------------------------
// Canonical app -> MCP tool-module mapping
// ---------------------------------------------------------------------------
// Keyed by LAUNCHPAD_CATALOG id (note: Bam's launchpad id is `b3`). The value
// is the ordered list of tool-module basenames (without .ts) that the
// mcp-server registers for that app in apps/mcp-server/src/server.ts. Apps
// backed by a single module list just that module; Bam spans many. Two
// cross-cutting modules are folded into the app they clearly belong to
// (banter-subscription -> banter, bolt-observability -> bolt); the remaining
// platform-level modules (agent/search/resolve/activity/...) are NOT app
// products - they are collected into a synthetic "Platform" product by the
// catalog generator (see listPlatformModules) so the /docs total equals the
// true count of registered tools, matching CLAUDE.md + the marketing site.
export const APP_TOOL_MODULES = {
  b3: [
    'project-tools',
    'task-tools',
    'sprint-tools',
    'comment-tools',
    'member-tools',
    'user-resolver-tools',
    'bam-resolver-tools',
    'epic-tools',
    'report-tools',
    'template-tools',
    'import-tools',
    'utility-tools',
    'me-tools',
    'platform-tools',
  ],
  banter: ['banter-tools', 'banter-subscription-tools'],
  beacon: ['beacon-tools'],
  bond: ['bond-tools'],
  blast: ['blast-tools'],
  bill: ['bill-tools'],
  blank: ['blank-tools'],
  book: ['book-tools'],
  bench: ['bench-tools'],
  brief: ['brief-tools'],
  bolt: ['bolt-tools', 'bolt-observability-tools'],
  bearing: ['bearing-tools'],
  board: ['board-tools'],
  blueprint: ['blueprint-tools'],
  bin: ['bin-tools'],
  bay: ['bay-tools'],
  blip: ['blip-tools'],
  helpdesk: ['helpdesk-tools'],
  bureau: ['bureau-tools'],
  basis: ['basis-tools'],
  braid: ['braid-tools'],
  bulwark: ['bulwark-tools'],
  burn: ['burn-tools'],
};

// Friendly category labels for tool modules. Used to group a multi-module
// app's tools (e.g. Bam) into readable sections. Single-module apps collapse
// to one "Tools" category (see build-docs-catalog.mjs).
export const MODULE_LABELS = {
  'project-tools': 'Projects & Board',
  'task-tools': 'Tasks',
  'sprint-tools': 'Sprints',
  'comment-tools': 'Comments',
  'member-tools': 'Members',
  'user-resolver-tools': 'People Lookup',
  'bam-resolver-tools': 'Resolvers',
  'epic-tools': 'Epics',
  'report-tools': 'Reports',
  'template-tools': 'Templates',
  'import-tools': 'Import',
  'utility-tools': 'Utility',
  'me-tools': 'Account',
  'platform-tools': 'Platform',
  'banter-tools': 'Messaging',
  'banter-subscription-tools': 'Agent Subscriptions',
  'bolt-tools': 'Automations',
  'bolt-observability-tools': 'Observability',
};

/** The docs/apps/<dir> folder name for a Launchpad id (Bam is `bam`, not `b3`). */
export function docDirForAppId(id) {
  return id === 'b3' ? 'bam' : id;
}

/**
 * Human-friendly label for a tool module basename, e.g. `bond-tools` -> `Bond`.
 */
export function moduleLabel(moduleName) {
  if (MODULE_LABELS[moduleName]) return MODULE_LABELS[moduleName];
  return moduleName
    .replace(/-tools$/, '')
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// LAUNCHPAD_CATALOG reader (authoritative app roster + ordering)
// ---------------------------------------------------------------------------

/**
 * Parse LAUNCHPAD_CATALOG out of system-settings.routes.ts. Returns an ordered
 * array of { id, name, description }. The catalog rows are single-line object
 * literals with single-quoted string fields, which we extract with a regex so
 * we do not have to import TypeScript from an .mjs script.
 */
export function readLaunchpadCatalog() {
  const src = fs.readFileSync(SYS_SETTINGS, 'utf-8');
  const startIdx = src.indexOf('export const LAUNCHPAD_CATALOG');
  if (startIdx === -1) {
    throw new Error('LAUNCHPAD_CATALOG not found in system-settings.routes.ts');
  }
  const arrStart = src.indexOf('[', startIdx);
  const arrEnd = src.indexOf('\n];', arrStart);
  const body = src.slice(arrStart, arrEnd === -1 ? undefined : arrEnd);

  const entries = [];
  const re =
    /\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',\s*description:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({ id: m[1], name: m[2], description: m[3] });
  }
  if (entries.length === 0) {
    throw new Error('LAUNCHPAD_CATALOG parsed to zero entries');
  }
  return entries;
}

// ---------------------------------------------------------------------------
// registerTool(...) block parser
// ---------------------------------------------------------------------------

/**
 * Extract a top-level string property (name / description) from the head of a
 * registerTool block. Delimiter-aware and escape-aware: it matches the opening
 * quote (single, double, or backtick) and reads until the matching closing
 * quote, so a description written with double quotes may contain apostrophes
 * without being truncated. Returns null if not present.
 */
function extractStringProp(head, key) {
  const re = new RegExp(
    `${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
  );
  const m = head.match(re);
  if (!m) return null;
  // Collapse escaped quotes/newlines and internal whitespace runs.
  return m[2]
    .replace(/\\(['"`\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find where the "input" block ends, at the first `returns:` or `handler:` key.
 */
function findInputBlockEnd(text) {
  const returnsIdx = text.search(/\n\s{2,}returns\s*:/);
  const handlerIdx = text.search(/\n\s{2,}handler\s*:/);
  const candidates = [returnsIdx, handlerIdx].filter((x) => x > 0);
  return candidates.length > 0 ? Math.min(...candidates) : text.length;
}

/**
 * Extract input parameter names from a registerTool chunk. Mirrors the legacy
 * extract.mjs behavior so the mcp-tools.md Parameters column stays stable.
 */
function extractInputParams(chunk) {
  const inputStart = chunk.indexOf('input:');
  if (inputStart === -1) return [];
  const afterInput = chunk.slice(inputStart);
  const endIdx = findInputBlockEnd(afterInput);
  const inputBlock = afterInput.slice(0, endIdx);

  const paramRegex = /^\s+(\w+)\s*:/gm;
  const params = [];
  let m;
  while ((m = paramRegex.exec(inputBlock)) !== null) {
    const paramName = m[1];
    if (['input', 'returns', 'handler', 'name', 'description'].includes(paramName)) {
      continue;
    }
    params.push(paramName);
  }
  return params;
}

/**
 * Strip `//` line comments and block comments from JS/TS source WITHOUT
 * touching the contents of string or template literals. A small character
 * scanner tracks whether we are inside a '..', "..", or `..` literal (honoring
 * backslash escapes) and removes comment spans found only in ordinary code.
 * Newlines inside stripped comments are preserved so downstream line-anchored
 * regexes (e.g. the input-param extractor) keep their line structure.
 *
 * This matters for correctness on two fronts:
 *   - a COMMENTED-OUT `registerTool(server, { ... })` block must not be counted
 *     as a phantom tool (overcount);
 *   - a JSDoc mention like `registerTool(...)` must not trip the non-standard
 *     shape detector below (false warning).
 */
export function stripComments(src) {
  let out = '';
  const n = src.length;
  let state = 'code'; // code | line | block | squote | dquote | template
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'squote'; }
      else if (c === '"') { state = 'dquote'; }
      else if (c === '`') { state = 'template'; }
      out += c;
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // keep line structure
      i++;
      continue;
    }
    // string / template states: copy verbatim, honoring backslash escapes.
    out += c;
    if (c === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
    if (
      (state === 'squote' && c === "'") ||
      (state === 'dquote' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    i++;
  }
  return out;
}

/**
 * Parse a single *-tools.ts file into an array of { name, description, params }.
 * Comments are stripped first (so a commented-out block is never miscounted),
 * then the source is split on `registerTool(server, {` boundaries and
 * name/description are read from the head of each block (before the input
 * schema, so param keys named `name` or `description` cannot shadow the tool's
 * own).
 *
 * Any `registerTool(` call that does NOT match the expected
 * `registerTool(server, { ... })` shape, or a matched block with no parseable
 * `name`, is pushed to `warnings` (tagged with `label`) so an unparsed
 * registration is visible instead of being silently dropped.
 */
export function parseToolsFromFile(filePath, warnings = [], label = null) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const src = stripComments(raw);
  const tools = [];
  const tag = label ? ` in ${label}` : '';

  const chunks = src.split(/registerTool\s*\(\s*server\s*,\s*\{/);
  let noNameBlocks = 0;
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Restrict name/description search to the block head (before input/handler)
    // so a nested schema field cannot be mistaken for the tool's own props.
    const headEnd = chunk.search(/\n\s*(?:input|inputSchema|handler|returns)\s*:/);
    const head = headEnd > 0 ? chunk.slice(0, headEnd) : chunk;

    const name = extractStringProp(head, 'name');
    if (!name) {
      noNameBlocks++;
      continue;
    }
    const description = extractStringProp(head, 'description') || '';
    const params = extractInputParams(chunk);

    tools.push({ name, description, params });
  }

  // Non-standard shapes: every `registerTool(` occurrence that the standard
  // split did not consume. `parsedShapes` is the number of standard-shape
  // boundaries (chunks.length - 1). If more `registerTool(` calls exist than
  // that, some registration uses an unrecognized shape and was skipped.
  const totalCalls = (src.match(/registerTool\s*\(/g) || []).length;
  const parsedShapes = chunks.length - 1;
  if (totalCalls > parsedShapes) {
    warnings.push(
      `${totalCalls - parsedShapes} registerTool(...) call(s)${tag} do not match the expected registerTool(server, { ... }) shape and were not parsed`,
    );
  }
  if (noNameBlocks > 0) {
    warnings.push(
      `${noNameBlocks} registerTool(server, { ... }) block(s)${tag} had no parseable name and were skipped`,
    );
  }

  return tools;
}

/**
 * Parse every tool for a given Launchpad app id, grouped by source module.
 * Returns [{ module, label, tools: [{ name, description, params }] }] in module
 * registration order. Missing module files are skipped (with a note pushed to
 * the optional `warnings` array).
 */
export function parseAppModules(appId, warnings = []) {
  const modules = APP_TOOL_MODULES[appId];
  if (!modules) {
    warnings.push(`No tool-module mapping for app id "${appId}"`);
    return [];
  }
  return parseModules(modules, warnings, appId);
}

/**
 * Parse an explicit ordered list of tool modules into groups. Shared by the
 * per-app path and the Platform product. Missing files are skipped with a note.
 */
export function parseModules(moduleNames, warnings = [], contextId = null) {
  const groups = [];
  for (const moduleName of moduleNames) {
    const fp = path.join(TOOLS_DIR, `${moduleName}.ts`);
    if (!fs.existsSync(fp)) {
      warnings.push(
        `Missing tool module file: ${moduleName}.ts${contextId ? ` (${contextId})` : ''}`,
      );
      continue;
    }
    const tools = parseToolsFromFile(fp, warnings, moduleName);
    groups.push({ module: moduleName, label: moduleLabel(moduleName), tools });
  }
  return groups;
}

/**
 * Classify a warning message as "structural" - i.e. it means the catalog is
 * almost certainly under- or over-counting: a missing app->module mapping, a
 * missing module file, a registration that did not match the parsed shape, or
 * a nameless block. These must be fatal so a silent undercount cannot corrupt
 * the canonical tool total. A legitimately tool-less app ("produced zero
 * tools") is deliberately NOT structural - it is the one soft case.
 *
 * The recognized message forms are produced in THIS file (parseAppModules,
 * parseModules, parseToolsFromFile), so keeping the classifier here keeps it in
 * lockstep with the strings it matches.
 */
export function isStructuralWarning(message) {
  return (
    /No tool-module mapping for app id/.test(message) ||
    /Missing tool module file:/.test(message) ||
    /do not match the expected registerTool/.test(message) ||
    /had no parseable name/.test(message)
  );
}

/** Every tool-module basename present on disk (without .ts), sorted. */
export function listAllToolModules() {
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('-tools.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
}

/**
 * The platform (cross-cutting) tool modules: every module on disk that no app
 * in APP_TOOL_MODULES claims. Derived, so a newly-added platform module is
 * picked up automatically with no edit here.
 */
export function listPlatformModules() {
  const mapped = new Set(Object.values(APP_TOOL_MODULES).flat());
  return listAllToolModules().filter((m) => !mapped.has(m));
}
