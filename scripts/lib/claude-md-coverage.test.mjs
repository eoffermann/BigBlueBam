// node --test scripts/lib/claude-md-coverage.test.mjs
//
// #376: CLAUDE.md is the first thing every agent reads, and its auth-core entry and db:check
// "Drift guard" section lagged the code by several batches. This guard fails when a new
// auth-core module or a new db-check rule lands without a CLAUDE.md mention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

test('the auth-core package entry names every auth-core module', () => {
  const line = claude.split('\n').find((l) => /^\s+auth-core\/\s/.test(l));
  assert.ok(line, 'CLAUDE.md has no packages/auth-core entry');
  const modules = readdirSync(join(ROOT, 'packages', 'auth-core', 'src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts' && f !== 'rows.ts');
  const missing = modules.filter((f) => !line.includes(f));
  assert.deepEqual(missing, [], `name these modules in the CLAUDE.md auth-core entry: ${missing.join(', ')}`);
  for (const fact of ['key_lookup', 'MAX_VERIFY_CANDIDATES', 'resolveOrgContext', 'requireKeyProjectChecked', 'refuseProjectRestrictedKey', 'auth-core-single-source.test.mjs']) {
    assert.ok(line.includes(fact), `CLAUDE.md auth-core entry should mention ${fact}`);
  }
});

test('the Drift guard section documents every db:check rule', () => {
  const start = claude.indexOf('### Drift guard');
  const end = claude.indexOf('### ', start + 5);
  assert.ok(start >= 0, 'CLAUDE.md has no Drift guard section');
  const section = claude.slice(start, end);
  const src = readFileSync(join(ROOT, 'scripts', 'db-check.mjs'), 'utf8');
  for (const m of src.matchAll(/export const ([A-Z_]+_ALLOWLIST)\b/g)) {
    assert.ok(section.includes(m[1]), `Drift guard section should explain ${m[1]}`);
  }
  for (const fn of src.matchAll(/export function (diff[A-Z]\w+)\(/g)) {
    const topic = { diffForeignKeys: /foreign key/i, diffNullability: /nullability/i }[fn[1]];
    if (topic) assert.match(section, topic, `Drift guard section should explain ${fn[1]}`);
  }
  assert.match(section, /stub/i, 'Drift guard section should say reference stubs must agree too');
});
