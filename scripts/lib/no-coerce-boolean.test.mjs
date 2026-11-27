// #251: the repo-level guard against z.coerce.boolean (see ./no-coerce-boolean.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCoerceBoolean, findRawEnvFlagCompares } from './no-coerce-boolean.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no source under apps/*/src or packages/*/src calls z.coerce.boolean', () => {
  assert.deepEqual(findCoerceBoolean(ROOT), []);
});

test('no source compares an env flag to a literal by hand (#302)', () => {
  assert.deepEqual(findRawEnvFlagCompares(ROOT), []);
});

test('the env-flag scan finds BBB_RLS_ENFORCE === "1" style reads and ignores assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-env-flag-'));
  try {
    mkdirSync(join(dir, 'apps', 'x-api', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'x-api', 'src', 'rls.ts'),
      [
        "// process.env.BBB_RLS_ENFORCE === '1' in prose is fine",
        "const enforce = process.env.BBB_RLS_ENFORCE === '1';",
        "const b = env.BBB_RLS_ENFORCE !== 'true';",
        "const c = process.env['SOME_FLAG'] == \"yes\";",
        "process.env.BBB_RLS_ENFORCE = '1';",
        "const d = env.BBB_RLS_ENFORCE;",
      ].join('\n'),
    );
    const hits = findRawEnvFlagCompares(dir, {});
    assert.deepEqual(
      hits.map((h) => h.split(':')[1]),
      ['2', '3', '4'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
