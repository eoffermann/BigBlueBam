// Issue #176: object storage has one implementation, @bigbluebam/storage. No app
// source builds its own MinIO client, and no app env schema defaults the S3
// credentials to minioadmin (storage without credentials is "not configured" and
// answers 503 STORAGE_NOT_CONFIGURED). Scans apps/*/src only: scripts/ (e.g. the
// gilligan seeders run inside the api container) may still use minio directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appsDir = join(repoRoot, 'apps');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const appSources = readdirSync(appsDir)
  .map((a) => join(appsDir, a, 'src'))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap((p) => walk(p));

const rel = (p) => relative(repoRoot, p).replaceAll('\\', '/');

/** Source files that import minio or construct a MinIO client. */
function minioClientOffenders(files, read = (f) => readFileSync(f, 'utf8')) {
  const out = [];
  for (const f of files) {
    const src = read(f);
    if (
      /from\s+['"]minio['"]/.test(src) ||
      /import\(\s*['"]minio['"]\s*\)/.test(src) ||
      /require\(\s*['"]minio['"]\s*\)/.test(src) ||
      /new\s+(?:Minio\.)?Client\s*\(\s*\{[^}]*endPoint/s.test(src)
    ) {
      out.push(rel(f));
    }
  }
  return out;
}

test('no app source builds its own MinIO client (use @bigbluebam/storage)', () => {
  assert.ok(appSources.length > 100, 'expected to scan the app sources');
  assert.deepEqual(minioClientOffenders(appSources), []);
});

test('no app env schema defaults the S3 credentials to minioadmin', () => {
  const offenders = appSources
    .filter((f) => /[\\/]env\.ts$/.test(f))
    .filter((f) => /S3_(ACCESS|SECRET)_KEY[^\n]*minioadmin/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(offenders, []);
});

test('no app source falls back to minioadmin credentials anywhere', () => {
  const offenders = appSources.filter((f) => /['"]minioadmin['"]/.test(readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(offenders, []);
});

test('the detector catches the shapes it guards against', () => {
  const fake = {
    'a.ts': "import * as Minio from 'minio';",
    'b.ts': "const { Client } = await import('minio');",
    'c.ts': "import { requireEnvBootstrapDriver } from '@bigbluebam/storage';",
  };
  const hits = minioClientOffenders(Object.keys(fake).map((k) => join(repoRoot, k)), (f) => fake[rel(f)]);
  assert.deepEqual(hits, ['a.ts', 'b.ts']);
});
