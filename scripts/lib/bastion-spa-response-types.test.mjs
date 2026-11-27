// #371: every Bastion response shape lives once, as a Zod schema in
// packages/shared/src/schemas/bastion.ts. bastion-api's services return those types, the MCP tools
// read through them, and the /bastion SPA only aliases them. Before #371 the SPA's
// apps/bastion/src/lib/api.ts hand-wrote ~50 response interfaces next to the API's own, and five
// issues in a row (#215, #231, #272, #348, #371) found them drifting from what the routes send.
//
// This guard fails when apps/bastion/src/lib/api.ts declares a type of its own (an interface, or a
// type alias with an object literal in it) instead of aliasing a @bigbluebam/shared type, and when
// an SPA call site spells a response body inline (api.get<{ data: { ... } }>). The allowlist holds
// the shapes that are not Bastion responses; it may only shrink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const API_TS = join(ROOT, 'apps', 'bastion', 'src', 'lib', 'api.ts');
const SPA_SRC = join(ROOT, 'apps', 'bastion', 'src');

/** Not Bastion responses: what Bam's own API (/b3/api) answers. Shrink only. */
const ALLOWED_LOCAL_TYPES = new Map([
  ['BamProject', 'GET/POST /b3/api/projects (Bam, not Bastion)'],
  ['OrgMember', 'GET /b3/api/org/members (Bam, not Bastion)'],
]);

/** Comments out, strings kept (a type literal never hides in a string here). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every type the file declares itself: interfaces, and aliases whose right side has an object literal. */
export function localTypeDeclarations(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/\binterface\s+([A-Z]\w*)/g)) out.push({ name: m[1], kind: 'interface' });
  for (const m of code.matchAll(/\btype\s+([A-Z]\w*)\s*(?:<[^=]*>)?\s*=([^;]*);/g)) {
    if (m[2].includes('{')) out.push({ name: m[1], kind: 'type literal' });
  }
  return out;
}

/** api.get / post / patch / roomRequest type arguments that spell a response body inline. */
export function inlineResponseLiterals(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/\b(?:api\.(?:get|post|patch)|roomRequest|request)\s*<\s*\{[^>]*?:\s*\{/g)) {
    out.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
  }
  for (const m of code.matchAll(/\b(?:api\.(?:get|post|patch)|roomRequest)\s*<[^>]*&\s*\{/g)) {
    out.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
  }
  return out;
}

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
  }
  return files;
}

test('the detectors are not vacuous', () => {
  const sample = [
    'export interface GapRow { id: string }',
    'interface Hidden { a: number }',
    'export type SummaryResponse = { data: { x: number } };',
    'export type Wrapped = BastionGapRow & { extra: string };',
    'export type Fine = BastionGapRow;',
    '// export interface Commented { a: string }',
  ].join('\n');
  assert.deepEqual(
    localTypeDeclarations(sample).map((d) => d.name).sort(),
    ['GapRow', 'Hidden', 'SummaryResponse', 'Wrapped'],
  );
  const calls = "api.get<{ data: { id: string } }>('/x'); api.post<BastionGapsResponse>('/y'); api.post<{ data: X & { check_result: string } }>('/z');";
  assert.equal(inlineResponseLiterals(calls).length, 2);
});

test('apps/bastion/src/lib/api.ts declares no response shape of its own (#371)', () => {
  const src = readFileSync(API_TS, 'utf8');
  assert.match(src, /from '@bigbluebam\/shared'/, 'api.ts must take its response types from @bigbluebam/shared');
  const offenders = localTypeDeclarations(src).filter((d) => !ALLOWED_LOCAL_TYPES.has(d.name));
  assert.deepEqual(
    offenders.map((d) => `${d.kind} ${d.name}`),
    [],
    'Add the response shape to packages/shared/src/schemas/bastion.ts as a Zod schema, return it from the bastion-api service, and alias it in api.ts.',
  );
});

test('the allowlist only names types api.ts still declares (it may only shrink)', () => {
  const declared = new Set(localTypeDeclarations(readFileSync(API_TS, 'utf8')).map((d) => d.name));
  const stale = [...ALLOWED_LOCAL_TYPES.keys()].filter((n) => !declared.has(n));
  assert.deepEqual(stale, [], 'Remove these from ALLOWED_LOCAL_TYPES: api.ts no longer declares them.');
});

test('no Bastion SPA call site spells a response body inline (#371)', () => {
  const offenders = [];
  for (const file of walk(SPA_SRC)) {
    for (const hit of inlineResponseLiterals(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file).split(sep).join('/')}: ${hit}`);
    }
  }
  assert.deepEqual(offenders, [], 'Type the call with the shared *Response type from @bigbluebam/shared.');
});
