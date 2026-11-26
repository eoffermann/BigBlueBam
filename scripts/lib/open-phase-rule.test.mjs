// #253: "which Bam phases are open" (a task can be filed into them) is one fact. The api's
// /internal/bastion task upsert decides it; Bastion's Setup, Readiness banner and re-drive gate
// must ask the same question. It lives in packages/shared/src/bam-phase-rules.ts
// (BAM_OPEN_PHASE_SQL). This test fails if the predicate is written out anywhere else in source,
// and if the known readers stop using the shared constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = 'packages/shared/src/bam-phase-rules.ts';
// The predicate in any spacing or case, with or without the outer parentheses.
const LITERAL = /is_start\s+OR\s+NOT\s+is_terminal/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

test('the open-phase predicate is written only in the shared owner', () => {
  const offenders = [];
  for (const top of ['apps', 'packages']) {
    for (const pkg of readdirSync(join(ROOT, top))) {
      const src = join(ROOT, top, pkg, 'src');
      if (!existsSync(src)) continue;
      for (const f of walk(src)) {
        const rel = relative(ROOT, f).replace(/\\/g, '/');
        if (rel === OWNER) continue;
        readFileSync(f, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (!/^\s*(\/\/|\*|\/\*)/.test(line) && LITERAL.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
  }
  assert.deepEqual(offenders, [], `write BAM_OPEN_PHASE_SQL from @bigbluebam/shared instead: ${offenders.join(', ')}`);
  assert.match(readFileSync(join(ROOT, OWNER), 'utf8'), LITERAL);
});

test('the api and Bastion read the shared predicate', () => {
  for (const rel of ['apps/api/src/services/bastion-internal.service.ts', 'apps/bastion-api/src/engine/remediation.ts']) {
    assert.match(readFileSync(join(ROOT, rel), 'utf8'), /BAM_OPEN_PHASE_SQL/, `${rel} reads BAM_OPEN_PHASE_SQL`);
  }
  // Setup asks through complianceProjectHealth, not its own query.
  assert.match(
    readFileSync(join(ROOT, 'apps/bastion-api/src/services/setup.service.ts'), 'utf8'),
    /complianceProjectHealth\(/,
  );
});
