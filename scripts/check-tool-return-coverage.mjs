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
const PUBLISHED = ['README.md', 'site/index.html', 'site/src/content/apps/introduction.md', 'site/src/lib/facts.ts'];
const COUNT_PATTERNS = [
  /\b(\d{3,4})(?:-tool\b| (?:MCP |AI |structured )?tools?\b)/gi,
  /MCP%20tools-(\d+)/g,
  /\b(\d{3,4}) across \d+ modules/g,
  /MCP_TOOL_COUNT = (\d+)/g,
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

if (!failed) {
  console.log('PASS: All tools use registerTool() with a returns: schema, and published counts match.');
}

process.exit(failed ? 1 : 0);
