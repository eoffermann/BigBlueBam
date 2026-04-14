#!/usr/bin/env node
// check-bolt-catalog.mjs
//
// Wave 0.4 / Cross_Product_Integration_Plan.md Step 4 (P0.3) drift guard.
//
// Enforces the naming convention sweep and signature invariants for every
// publishBoltEvent call site across apps/ and packages/. The plan text says
// this script was intended to be a §2.1 (Wave 0.1) artifact and extended
// here; in practice it did not exist when Wave 0.4 opened, so it is created
// in this commit. See DECISIONS.md D-011.
//
// Rules enforced (any violation exits 1):
//
//   R1  First positional arg must be a string literal.
//       Rationale: dynamic event types defeat the catalog/drift guard.
//
//   R2  First positional arg must be a bare event name (no source-service
//       prefix). The canonical form is `<domain>.<action>` (e.g.
//       'deal.rotting', 'task.created', 'comment.created'). Legitimate
//       names where the domain happens to equal a source name (e.g.
//       'beacon.created', 'board.updated') are allowed because they are
//       the catalog-canonical form. Only exact-match prefixed names in
//       PREFIXED_BAD_NAMES are rejected.
//
//       Keep the deny-list explicit. Adding a new known-bad name here is
//       the right place to catch future regressions without false-positive
//       cascades on the many legitimate bare names that start with a
//       source-service word.
//
//   R3  Second positional arg must be a string literal equal to one of
//       the BoltEventSource values declared in
//       packages/shared/src/bolt-events.ts (= BoltEventSource union).
//       Rationale: Zod validates `source` at the ingest route against
//       the same enum; drift here produces runtime 400s on ingest.
//
// Usage: node scripts/check-bolt-catalog.mjs
// Exit:  0 on clean, 1 on any violation.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Keep in sync with packages/shared/src/bolt-events.ts BoltEventSource.
const KNOWN_SOURCES = new Set([
  'bam',
  'banter',
  'beacon',
  'bearing',
  'bench',
  'bill',
  'blank',
  'blast',
  'board',
  'bolt',
  'bond',
  'book',
  'brief',
  'helpdesk',
  'schedule',
]);

// Explicit deny-list of legacy prefixed event names. Add a new entry here
// when a new service introduces a wrongly-prefixed name. The entry should
// be the exact literal value that appears in source, minus the quotes.
const PREFIXED_BAD_NAMES = new Set([
  'bond.deal.rotting',
]);

// Directories to scan. Kept short and explicit so the script has no
// accidental surface-area growth when new top-level folders appear.
const SCAN_ROOTS = ['apps', 'packages'];

// File filter: only .ts, skip tests, skip .d.ts, skip the implementation
// file (packages/shared/src/bolt-events.ts defines the function, not a
// call site).
function isScanCandidate(absPath) {
  if (!absPath.endsWith('.ts')) return false;
  if (absPath.endsWith('.d.ts')) return false;
  const rel = relative(ROOT, absPath).replace(/\\/g, '/');
  if (rel.includes('/test/')) return false;
  if (rel.includes('/tests/')) return false;
  if (rel.endsWith('.test.ts')) return false;
  if (rel.endsWith('.spec.ts')) return false;
  if (rel === 'packages/shared/src/bolt-events.ts') return false;
  if (rel.includes('/node_modules/')) return false;
  if (rel.includes('/dist/')) return false;
  return true;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.turbo') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && isScanCandidate(full)) {
      out.push(full);
    }
  }
  return out;
}

// Find every publishBoltEvent(...) call. Multi-line aware: the parser
// scans forward from each `publishBoltEvent(` occurrence, picking off the
// first and second comma-separated top-level arguments while respecting
// string literals, template literals, and parenthesis depth.
function extractCalls(content) {
  const calls = [];
  const needle = 'publishBoltEvent(';
  let idx = 0;
  while (true) {
    const at = content.indexOf(needle, idx);
    if (at === -1) break;
    // Skip function *declarations* / *definitions* / imports / comments:
    //   export async function publishBoltEvent(...
    //   export declare function publishBoltEvent(...
    //   import { publishBoltEvent } from ...
    //   // publishBoltEvent: ...
    const preSlice = content.slice(Math.max(0, at - 60), at);
    if (/\bfunction\s+$/.test(preSlice)) {
      idx = at + needle.length;
      continue;
    }
    if (/\bimport\b[^;]*\{\s*$/.test(preSlice)) {
      idx = at + needle.length;
      continue;
    }
    // Skip if we're inside a line comment
    const lineStart = content.lastIndexOf('\n', at) + 1;
    const lineUpToCall = content.slice(lineStart, at);
    if (lineUpToCall.includes('//')) {
      idx = at + needle.length;
      continue;
    }
    // Skip if inside a block comment. Rough heuristic: previous /* is
    // unmatched by a */ before our position.
    const lastOpen = content.lastIndexOf('/*', at);
    const lastClose = content.lastIndexOf('*/', at);
    if (lastOpen !== -1 && lastOpen > lastClose) {
      idx = at + needle.length;
      continue;
    }

    const argsStart = at + needle.length;
    const parsed = parseCallArgs(content, argsStart);
    if (parsed) {
      const line = content.slice(0, at).split('\n').length;
      calls.push({ line, firstArg: parsed.args[0], secondArg: parsed.args[1] });
    }
    idx = argsStart;
  }
  return calls;
}

// Parse args starting from the first char INSIDE the paren. Returns
// { args: string[], endIndex } where each arg is the raw token text.
// Only collects the first 2 args; beyond that we stop tracking because
// this guard only cares about eventType and source.
function parseCallArgs(src, start) {
  const args = [];
  let depth = 0; // paren depth (we start at depth 0 INSIDE the first paren)
  let braceDepth = 0;
  let bracketDepth = 0;
  let stringChar = null; // `'` | `"` | `` ` ``
  let templateDepth = 0; // nested ${...} counter
  let curStart = start;
  let i = start;

  while (i < src.length) {
    const c = src[i];
    const prev = src[i - 1];

    if (stringChar) {
      if (c === '\\' && prev !== '\\') {
        i += 2;
        continue;
      }
      if (stringChar === '`' && c === '$' && src[i + 1] === '{') {
        templateDepth++;
        i += 2;
        continue;
      }
      if (c === stringChar && prev !== '\\') {
        stringChar = null;
      }
      i++;
      continue;
    }
    if (templateDepth > 0 && c === '}') {
      templateDepth--;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      stringChar = c;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0 && braceDepth === 0 && bracketDepth === 0) {
        // End of call.
        const tok = src.slice(curStart, i).trim();
        if (tok.length > 0 || args.length > 0) args.push(tok);
        return { args, endIndex: i + 1 };
      }
      depth--;
      i++;
      continue;
    }
    if (c === '{') { braceDepth++; i++; continue; }
    if (c === '}') { braceDepth--; i++; continue; }
    if (c === '[') { bracketDepth++; i++; continue; }
    if (c === ']') { bracketDepth--; i++; continue; }
    if (c === ',' && depth === 0 && braceDepth === 0 && bracketDepth === 0) {
      args.push(src.slice(curStart, i).trim());
      curStart = i + 1;
      if (args.length >= 2) {
        // We already have eventType and source; scan forward to the
        // matching close paren for completeness, but do not track more
        // args. Short-circuit: just walk to the end.
        // We still need to exit cleanly so the caller can move on.
      }
      i++;
      continue;
    }
    i++;
  }
  return null;
}

function unquote(tok) {
  if (!tok) return null;
  const m = tok.match(/^(['"`])(.*)\1$/s);
  return m ? m[2] : null;
}

function main() {
  const files = [];
  for (const r of SCAN_ROOTS) {
    walk(join(ROOT, r), files);
  }

  const violations = [];
  let callsScanned = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes('publishBoltEvent(')) continue;

    const calls = extractCalls(content);
    for (const call of calls) {
      callsScanned++;
      const rel = relative(ROOT, file).replace(/\\/g, '/');

      // R1: first arg must be a string literal.
      const firstLit = unquote(call.firstArg);
      if (firstLit === null) {
        violations.push({
          file: rel,
          line: call.line,
          rule: 'R1-first-arg-literal',
          msg: `publishBoltEvent first argument must be a string literal, got \`${call.firstArg ?? '<empty>'}\``,
        });
        continue;
      }

      // R2: event name must not be in the legacy prefixed deny-list.
      if (PREFIXED_BAD_NAMES.has(firstLit)) {
        violations.push({
          file: rel,
          line: call.line,
          rule: 'R2-no-prefixed-event',
          msg: `event name '${firstLit}' is a legacy prefixed name; strip the source prefix (see Cross_Product_Integration_Plan.md Step 4 / P0.3)`,
        });
      }

      // R3: second arg must be a string literal in KNOWN_SOURCES.
      const secondLit = unquote(call.secondArg);
      if (secondLit === null) {
        violations.push({
          file: rel,
          line: call.line,
          rule: 'R3-source-literal',
          msg: `publishBoltEvent second argument must be a string literal source, got \`${call.secondArg ?? '<missing>'}\``,
        });
      } else if (!KNOWN_SOURCES.has(secondLit)) {
        violations.push({
          file: rel,
          line: call.line,
          rule: 'R3-source-enum',
          msg: `publishBoltEvent source '${secondLit}' is not in BoltEventSource union (packages/shared/src/bolt-events.ts)`,
        });
      }
    }
  }

  console.log(`[check-bolt-catalog] scanned ${files.length} file(s), ${callsScanned} publishBoltEvent call(s)`);

  if (violations.length === 0) {
    console.log('[check-bolt-catalog] clean');
    process.exit(0);
  }

  for (const v of violations) {
    console.error(`${v.file}:${v.line}  [${v.rule}] ${v.msg}`);
  }
  console.error(`\n[check-bolt-catalog] ${violations.length} violation(s)`);
  process.exit(1);
}

main();
