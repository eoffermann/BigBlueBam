// node:test for the route-coverage guard in scripts/check-permission-catalog.mjs (issue #153).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeCoverageProblems } from '../check-permission-catalog.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'perm-coverage-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  mkdirSync(join(root, 'apps', 'mcp-server', 'src', 'routes'), { recursive: true });
  return root;
}

const manifest = {
  permissions: [
    { id: 'foo.widget.read', app: 'foo', sources: [{ source: 'rest', ref: 'hand_authored (migration 9999)' }] },
    { id: 'bar.thing.list', app: 'bar', sources: [{ source: 'rest', ref: 'GET /things' }] },
  ],
};

test('an app whose route files reference no catalog id fails', () => {
  const root = fixture({ 'apps/foo-api/src/routes/widgets.routes.ts': "fastify.get('/widgets', { preHandler: [requireAuth] }, h);" });
  const { problems } = routeCoverageProblems(root, manifest);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/foo-api: its route files contribute zero catalog actions/);
});

test('a hand-authored id is only coverage when a route file actually passes it', () => {
  const root = fixture({
    'apps/foo-api/src/routes/widgets.routes.ts': "fastify.get('/widgets', { preHandler: [requireAuth, fastify.requireCan('foo.widget.read')] }, h);",
  });
  assert.deepEqual(routeCoverageProblems(root, manifest).problems, []);
});

test('path-derived scanner rows count as coverage for a scanned app', () => {
  const root = fixture({ 'apps/bar-api/src/routes/things.routes.ts': "fastify.get('/things', h);" });
  assert.deepEqual(routeCoverageProblems(root, manifest).problems, []);
});

test('a route id that is not in the catalog fails', () => {
  const root = fixture({
    'apps/foo-api/src/routes/widgets.routes.ts': "fastify.post('/w', { preHandler: [can('foo.widget.read'), fastify.requireCan('foo.widget.zap')] }, h);",
  });
  const { problems } = routeCoverageProblems(root, manifest);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /'foo\.widget\.zap', which is not in the catalog/);
});

test('the real repo: blueprint-api and bureau-api now contribute actions', () => {
  const { problems, coverage } = routeCoverageProblems(REPO_ROOT);
  assert.deepEqual(problems, []);
  assert.ok(coverage['blueprint-api'] >= 7, `blueprint-api coverage ${coverage['blueprint-api']}`);
  assert.ok(coverage['bureau-api'] >= 22, `bureau-api coverage ${coverage['bureau-api']}`);
});
