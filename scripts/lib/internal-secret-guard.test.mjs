// #252: the repo guard that keeps internal-secret checks in the one shared guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInternalSecretHeaderReads } from './internal-secret-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('no service reads an internal-secret header outside the shared guard', () => {
  assert.deepEqual(findInternalSecretHeaderReads(ROOT), []);
});

test('reads are found; outgoing header assignments and comments are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'internal-guard-'));
  try {
    mkdirSync(join(dir, 'apps', 'x-api', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'apps', 'x-api', 'src', 'routes.ts'),
      [
        "const provided = request.headers['x-internal-secret'];",
        "headers['x-internal-secret'] = env.INTERNAL_SERVICE_SECRET;",
        "// request.headers['x-internal-secret'] in a comment",
        "const t = headerValue(request, 'x-internal-token');",
        "fetch(url, { headers: { 'X-Internal-Secret': secret } });",
      ].join('\n'),
    );
    const hits = findInternalSecretHeaderReads(dir);
    assert.deepEqual(hits.map((h) => h.split(':')[1]), ['1', '4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
