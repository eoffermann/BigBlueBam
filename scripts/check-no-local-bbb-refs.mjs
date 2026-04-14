#!/usr/bin/env node
// check-no-local-bbb-refs.mjs
//
// Wave 1.D drift guard for @bigbluebam/db-stubs rollout.
//
// After Wave 1.D consolidated the 13 hand-maintained
// `apps/<svc>/src/db/schema/bbb-refs.ts` copies behind a single shared
// package, any new `pgTable(...)` declaration inside a service's bbb-refs
// file is almost always drift: a local redefinition that will silently
// diverge from the Bam canonical and break cross-service queries or
// pnpm db:check runs.
//
// This script walks every `apps/*/src/db/schema/bbb-refs.ts` and fails if
// any file contains a `pgTable(...)` call. The sanctioned shim content is:
//
//     export * from '@bigbluebam/db-stubs';
//     // plus optional aliased re-exports like `projectMembers`
//
// Exceptions: a file may add a single `noqa: local-bbb-ref <reason>`
// comment per declaration if a legitimate local override exists (e.g.
// brief-api still needs a local `tasks` stub with a non-canonical
// `org_id` column until the Brief Wave 2 plan fixes the consumer code).
// Each noqa requires a short reason string so the drift stays visible in
// PR review.
//
// Exit 0 on clean, 1 on drift.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const appsDir = join(repoRoot, 'apps');
// Match the noqa tag anywhere on the captured line. `.*?` is non-greedy so
// the reason capture stops at the first CR/LF. We use `[^\r\n]*` for the
// trailing portion so CRLF line endings do not prevent a match.
const NOQA_RE = /noqa:\s*local-bbb-ref\s+([^\r\n]+)/;
const PGTABLE_RE = /\bpgTable\s*\(/g;

/**
 * Strip single-line `//`, block `/* ... *\/`, and string literals (backtick,
 * double, single) from a source string so comment references to "pgTable"
 * like `pgTable(...)` in a module docblock do not trip the check. We
 * preserve line count and offsets by replacing the stripped content with
 * spaces of the same length.
 */
function stripCommentsAndStrings(source) {
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  cleaned = cleaned.replace(/(^|[^:])\/\/[^\n]*/g, (m) =>
    m.replace(/\/\/[^\n]*/, (mm) => ' '.repeat(mm.length)),
  );
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, (m) => m.replace(/[^\n]/g, ' '));
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/[^\n]/g, ' '));
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '));
  return cleaned;
}

function collectBbbRefsFiles() {
  const out = [];
  const apps = readdirSync(appsDir).filter((name) => {
    try {
      return statSync(join(appsDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
  for (const app of apps) {
    const candidate = join(appsDir, app, 'src', 'db', 'schema', 'bbb-refs.ts');
    try {
      if (statSync(candidate).isFile()) out.push(candidate);
    } catch {
      // no file, skip
    }
  }
  return out;
}

function lineCovering(source, matchIndex) {
  let lineStart = matchIndex;
  while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart -= 1;
  let lineEnd = matchIndex;
  while (lineEnd < source.length && source[lineEnd] !== '\n') lineEnd += 1;
  return source.slice(lineStart, lineEnd);
}

function lineNumber(source, matchIndex) {
  let n = 1;
  for (let i = 0; i < matchIndex; i += 1) if (source[i] === '\n') n += 1;
  return n;
}

const files = collectBbbRefsFiles();
const violations = [];
const honoredOverrides = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const sanitized = stripCommentsAndStrings(source);
  const matches = [...sanitized.matchAll(PGTABLE_RE)];
  for (const match of matches) {
    const idx = match.index ?? 0;
    // Use the ORIGINAL source to look up the surrounding line so we can
    // still find the `noqa: local-bbb-ref <reason>` tag.
    const line = lineCovering(source, idx);
    const noqa = line.match(NOQA_RE);
    const rel = file.slice(repoRoot.length + 1).replaceAll('\\', '/');
    const lineNo = lineNumber(source, idx);
    if (noqa) {
      honoredOverrides.push({ file: rel, line: lineNo, reason: noqa[1].trim() });
      continue;
    }
    violations.push({ file: rel, line: lineNo });
  }
}

if (honoredOverrides.length > 0) {
  console.log('Honored local overrides (noqa: local-bbb-ref):');
  for (const o of honoredOverrides) {
    console.log(`  ${o.file}:${o.line}  - ${o.reason}`);
  }
  console.log('');
}

if (violations.length === 0) {
  console.log(
    `check-no-local-bbb-refs: clean (${files.length} bbb-refs files scanned, no local pgTable declarations)`,
  );
  process.exit(0);
}

console.error('check-no-local-bbb-refs: drift detected');
console.error('');
console.error(
  'Every apps/*/src/db/schema/bbb-refs.ts must re-export from @bigbluebam/db-stubs',
);
console.error(
  'and must not declare its own pgTable(...). Local overrides require an inline',
);
console.error(
  '"// noqa: local-bbb-ref <reason>" comment on the same line as the pgTable call.',
);
console.error('');
console.error('Offenders:');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  contains pgTable(...)`);
}
process.exit(1);
