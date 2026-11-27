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

// #306: a constant-keyed read used to pass the check.
test('reads keyed by a constant bound to a secret header name are found, local or imported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'internal-guard-const-'));
  try {
    mkdirSync(join(dir, 'packages', 'consts', 'src'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'x-api', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'consts', 'src', 'index.ts'),
      "export const INTERNAL_TOKEN_HEADER = 'x-internal-token';\n",
    );
    writeFileSync(
      join(dir, 'apps', 'x-api', 'src', 'routes.ts'),
      [
        "import { INTERNAL_TOKEN_HEADER } from '@x/consts';",
        "const SECRET_HEADER: string = 'X-Internal-Secret';",
        'const a = request.headers[INTERNAL_TOKEN_HEADER];',
        'const b = req.headers[ SECRET_HEADER ];',
        'outgoing.headers[SECRET_HEADER] = secret;',
        'const c = request.headers.get(SECRET_HEADER);',
        'const d = headerValue(request, INTERNAL_TOKEN_HEADER);',
        'const { [SECRET_HEADER]: e } = request.headers;',
        'const f = request.headers[OTHER_HEADER];',
      ].join('\n'),
    );
    const hits = findInternalSecretHeaderReads(dir);
    assert.deepEqual(hits.map((h) => h.split(':')[1]), ['3', '4', '6', '7', '8']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
