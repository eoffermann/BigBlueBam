// Refs #259: in a job made of independent checks, one failing step must not make every later check
// skip (GitHub's default `if: success()`). Every check after the prerequisite step carries
// `if: ${{ !cancelled() ... }}`, so each one reports on every run while the job still fails when any
// check fails. A new check step added without it would silently reintroduce the skip chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// workflow file -> the job's prerequisite step; every step after it must have a !cancelled() if:.
const CHAINS = [
  { file: 'lint.yml', job: 'biome', after: 'Install dependencies' },
  { file: 'db-drift.yml', job: 'db-drift', after: 'Apply migrations (via migrate runner)' },
  { file: 'migration-replay.yml', job: 'migration-replay', after: 'Apply all migrations (full replay)' },
];

/** [{ name, if }] for the steps of one job. */
function steps(file, job) {
  const lines = readFileSync(join(ROOT, '.github/workflows', file), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(start >= 0, `${file}: job ${job} not found`);
  const out = [];
  for (let i = start + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i++) {
    const m = /^\s+- name: (.+)$/.exec(lines[i]);
    if (m) out.push({ name: m[1].trim(), if: null });
    const cond = /^\s+if: (.+)$/.exec(lines[i]);
    if (cond && out.length > 0) out[out.length - 1].if = cond[1].trim();
  }
  return out;
}

for (const { file, job, after } of CHAINS) {
  test(`${file} ${job}: every check after "${after}" runs unless the run was cancelled`, () => {
    const all = steps(file, job);
    const at = all.findIndex((s) => s.name === after);
    assert.ok(at >= 0, `prerequisite step "${after}" not found`);
    const checks = all.slice(at + 1);
    assert.ok(checks.length > 0);
    const missing = checks.filter((s) => !s.if || !s.if.includes('!cancelled()')).map((s) => s.name);
    assert.deepEqual(missing, [], `add if: \${{ !cancelled() ... }} to: ${missing.join(', ')}`);
  });
}
