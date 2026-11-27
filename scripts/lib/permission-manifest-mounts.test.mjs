// node --test scripts/lib/permission-manifest-mounts.test.mjs
//
// Issue #378: the permission-manifest generator did not compose server.ts mount
// prefixes, so a route file mounted at `/internal` that declares a bare path
// (`POST /projects/ensure`) was scanned as a user-facing permission and turned
// Lint red. Internal routes are now excluded by rule, from the mount itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMountPrefixes } from '../generate-permission-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('readMountPrefixes maps route files to their server.ts prefixes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-mounts-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'server.ts'),
      [
        "import internalThingRoutes from './routes/internal-thing.routes.js';",
        "import llm, { drain } from './routes/internal-llm.routes.js';",
        "import plain from './routes/plain.routes.js';",
        "await fastify.register(internalThingRoutes, { prefix: '/internal' });",
        "await fastify.register(llm, { prefix: '/internal/llm' });",
        'await fastify.register(plain);',
      ].join('\n'),
    );
    const m = readMountPrefixes(dir);
    assert.deepEqual(m.get('internal-thing.routes.ts'), ['/internal']);
    assert.deepEqual(m.get('internal-llm.routes.ts'), ['/internal/llm']);
    assert.equal(m.has('plain.routes.ts'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the api server mounts internal-projects under /internal', () => {
  const m = readMountPrefixes(join(ROOT, 'apps', 'api', 'src'));
  assert.deepEqual(m.get('internal-projects.routes.ts'), ['/internal']);
});

test('no manifest permission is sourced from a route file mounted under /internal', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'docs', 'permissions-action-manifest.json'), 'utf8'));
  const internalFiles = new Set();
  for (const app of ['api']) {
    for (const [file, mounts] of readMountPrefixes(join(ROOT, 'apps', app, 'src'))) {
      if (mounts.every((p) => p === '/internal' || p.startsWith('/internal/'))) internalFiles.add(file);
    }
  }
  const leaked = [];
  for (const p of manifest.permissions) {
    for (const s of p.sources || []) {
      if (s.source === 'rest' && internalFiles.has(s.file)) leaked.push(`${p.id} <- ${s.ref} (${s.file})`);
    }
  }
  assert.deepEqual(leaked, []);
});
