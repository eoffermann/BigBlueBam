// #251: the repo-level guard against z.coerce.boolean (see ./no-coerce-boolean.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCoerceBoolean } from './no-coerce-boolean.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no source under apps/*/src or packages/*/src calls z.coerce.boolean', () => {
  assert.deepEqual(findCoerceBoolean(ROOT), []);
});

test('the scan finds a real call and ignores comment-only mentions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-coerce-bool-'));
  try {
    mkdirSync(join(dir, 'apps', 'x-api', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'x-api', 'src', 'env.ts'),
      [
        "// never use z.coerce.boolean() here",
        ' * z.coerce.boolean() in a doc comment',
        '  FLAG: z.coerce.boolean().default(false),',
      ].join('\n'),
    );
    const hits = findCoerceBoolean(dir);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^apps\/x-api\/src\/env\.ts:3: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
