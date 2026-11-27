#!/usr/bin/env node
/**
 * check-tool-return-coverage.mjs
 *
 * Scans all files matching apps/mcp-server/src/tools/*-tools.ts.
 * Verifies:
 *   1. Zero remaining `server.tool(` calls (all must be converted to registerTool).
 *   2. Every `registerTool(server, {` block has a `returns:` key.
 *
 * Exits 0 on full coverage, 1 on any violation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'apps/mcp-server/src/tools');

const files = readdirSync(TOOLS_DIR)
  .filter((f) => f.endsWith('-tools.ts'))
  .sort();

let totalRegisterTool = 0;
let totalServerTool = 0;
let totalMissingReturns = 0;

const serverToolOffenders = [];
const missingReturnsOffenders = [];

for (const file of files) {
  const filePath = join(TOOLS_DIR, file);
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');

  // --- Check 1: count server.tool( calls ---
  for (let i = 0; i < lines.length; i++) {
    if (/server\.tool\s*\(/.test(lines[i])) {
      totalServerTool++;
      serverToolOffenders.push(`${file}:${i + 1}`);
    }
  }

  // --- Check 2: find registerTool blocks and verify returns: key ---
  // Strategy: find each `registerTool(server, {` and read forward until
  // the matching `});` at brace depth 0, then check for `returns:`.
  const registerRe = /registerTool\s*\(\s*server\s*,\s*\{/g;
  let m;
  while ((m = registerRe.exec(source)) !== null) {
    totalRegisterTool++;

    // Find the opening brace of the options object
    const braceStart = source.indexOf('{', m.index + m[0].indexOf('{'));
    if (braceStart < 0) continue;

    // Read forward counting brace depth to find the matching close
    let depth = 0;
    let inString = null;
    let blockEnd = -1;
    for (let i = braceStart; i < source.length; i++) {
      const c = source[i];
      if (inString) {
        if (c === '\\') { i++; continue; }
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }

    if (blockEnd < 0) continue;

    const block = source.slice(braceStart, blockEnd + 1);

    // Check for a top-level `returns:` key (not nested).
    // We look for `returns:` at brace depth 1 within the block.
    let hasReturns = false;
    let bd = 0;
    let ins = null;
    for (let i = 0; i < block.length - 7; i++) {
      const c = block[i];
      if (ins) {
        if (c === '\\') { i++; continue; }
        if (c === ins) ins = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { ins = c; continue; }
      if (c === '{' || c === '[' || c === '(') bd++;
      else if (c === '}' || c === ']' || c === ')') bd--;
      // Only look at depth 1 (inside the options object, outside nested objects)
      if (bd === 1 && block.slice(i).match(/^returns\s*:/)) {
        hasReturns = true;
        break;
      }
    }

    if (!hasReturns) {
      totalMissingReturns++;
      // Find the line number of this registerTool call
      const linesBefore = source.slice(0, m.index).split('\n');
      const lineNum = linesBefore.length;
      missingReturnsOffenders.push(`${file}:${lineNum}`);
    }
  }
}

// --- Summary ---
console.log('');
console.log('MCP Tool Return Coverage Check');
console.log('==============================');
console.log(`files scanned:         ${files.length}`);
console.log(`registerTool calls:    ${totalRegisterTool}`);
console.log(`server.tool calls:     ${totalServerTool} (expected 0)`);
console.log(`missing returns:       ${totalMissingReturns} (expected 0)`);
console.log('');

let failed = false;

if (totalServerTool > 0) {
  failed = true;
  console.error(`FAIL: ${totalServerTool} unconverted server.tool() call(s) found:`);
  for (const loc of serverToolOffenders) {
    console.error(`  ${loc}`);
  }
  console.error('');
}

if (totalMissingReturns > 0) {
  failed = true;
  console.error(`FAIL: ${totalMissingReturns} registerTool() call(s) missing "returns:" key:`);
  for (const loc of missingReturnsOffenders) {
    console.error(`  ${loc}`);
  }
  console.error('');
}

// --- Check 3: published tool counts match the code ---
// The README and the marketing site state the tool count. It drifted to a
// stale 804 for months; this keeps every published number equal to the real one.
const PUBLISHED = [
  'README.md',
  'site/index.html',
  'site/src/lib/facts.ts',
  // Issue #143: the suite introduction (in-app Help Center, guide, manual sources).
  'docs/apps/introduction/help.md',
  'docs/apps/introduction/help-index.json',
  'docs/apps/introduction/guide.md',
  'docs/apps/introduction/marketing.md',
  'docs/apps/introduction/mcp-tools.md',
  'docs/apps/introduction/_narrative.md',
  'docs/apps/introduction/_marketing_hook.md',
  'docs/apps/introduction/meta.json',
];
const COUNT_PATTERNS = [
  /\b(\d{3,4})(?:-tool\b| (?:MCP |AI |structured )?tools?\b)/gi,
  /MCP%20tools-(\d+)/g,
  /\b(\d{3,4}) across \d+ modules/g,
  /MCP_TOOL_COUNT = (\d+)/g,
  // "(885 across the suite)", "exposes 885 of them", "ships 885 of these tools"
  /\b(\d{3,4}) (?:across the suite|of them|of these)\b/g,
  /"mcp_tool_count":\s*(\d+)/g,
];
const staleCounts = [];
for (const rel of PUBLISHED) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of COUNT_PATTERNS) {
      for (const m of lines[i].matchAll(re)) {
        const n = Number(m[1]);
        // Per-app counts ("123 MCP tools" for Bam) are legitimate; only a
        // suite total (no single app is anywhere near 500) must equal the code.
        if (n >= 500 && n !== totalRegisterTool) staleCounts.push(`${rel}:${i + 1} says ${m[1]}`);
      }
    }
  }
}
console.log(`published counts:      ${staleCounts.length} stale (expected 0)`);
if (staleCounts.length > 0) {
  failed = true;
  console.error(`FAIL: published MCP tool counts differ from the ${totalRegisterTool} registered tools:`);
  for (const loc of staleCounts) {
    console.error(`  ${loc}`);
  }
  console.error('');
}

// --- Check 4 (issue #410): no em dash in tool source or in the docs generated from it ---
// Tool descriptions and input .describe() strings are copied verbatim into
// mcp-tools.md, the per-app guide.md tables, the /docs catalog, the Manual and
// the bolt-api tool-schema snapshot. The house rule is no em dashes in published
// docs, and a generated file cannot be fixed by hand, so the rule is enforced at
// the source (every file in the tools directory) and re-checked on the outputs.
const EM_DASH = '—';
const emDashOffenders = [];
function scanEmDash(rel) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(EM_DASH)) emDashOffenders.push(`${rel}:${i + 1}`);
  }
}
for (const f of readdirSync(TOOLS_DIR).filter((x) => x.endsWith('.ts')).sort()) {
  scanEmDash(`apps/mcp-server/src/tools/${f}`);
}
const GENERATED_FROM_TOOLS = [
  'README.md',
  'site/src/content/docs-catalog.generated.json',
  'site/src/content/manual.generated.json',
  'apps/bolt-api/src/services/mcp-tool-schemas.generated.ts',
];
const APPS_DOCS = join(ROOT, 'docs/apps');
for (const dir of readdirSync(APPS_DOCS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const f of ['guide.md', 'mcp-tools.md']) {
    const rel = `docs/apps/${dir.name}/${f}`;
    if (readdirSync(join(APPS_DOCS, dir.name)).includes(f)) GENERATED_FROM_TOOLS.push(rel);
  }
}
for (const rel of GENERATED_FROM_TOOLS) scanEmDash(rel);
console.log(`em dashes:             ${emDashOffenders.length} (expected 0)`);
if (emDashOffenders.length > 0) {
  failed = true;
  console.error('FAIL: em dash (U+2014) in MCP tool source or in a doc generated from it. Reword with a comma, colon, or " - ":');
  for (const loc of emDashOffenders) console.error(`  ${loc}`);
  console.error('');
}

if (!failed) {
  console.log('PASS: All tools use registerTool() with a returns: schema, published counts match, and no em dashes.');
}

process.exit(failed ? 1 : 0);
