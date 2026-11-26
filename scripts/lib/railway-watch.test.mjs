// node --test scripts/lib/railway-watch.test.mjs
// Issue #170: every package (and app) a Dockerfile COPYs must be in that service's
// Railway watchPatterns, or a change to it deploys to no service at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerfileCopiedDirs, railwayWatchProblems } from './railway-watch.mjs';
import { REPO_ROOT } from './bolt-sources.mjs';

test('dockerfileCopiedDirs reads repo COPY sources and skips stage copies', () => {
  const dockerfile = [
    'FROM node:22-alpine AS build',
    'COPY package.json pnpm-workspace.yaml ./',
    'COPY apps/bill-api/package.json ./apps/bill-api/',
    'COPY packages/shared/package.json ./packages/shared/',
    'COPY packages/storage/ ./packages/storage/',
    'COPY ./packages/logging/src packages/service-health/src \\',
    '     ./x/',
    'COPY --from=build /app/packages/permissions/dist ./dist',
    'COPY --chown=node:node packages/db-stubs/ ./packages/db-stubs/',
    'COPY infra/postgres/migrations/ ./migrations/',
  ].join('\n');
  assert.deepEqual(dockerfileCopiedDirs(dockerfile), [
    'apps/bill-api',
    'packages/shared',
    'packages/storage',
    'packages/logging',
    'packages/service-health',
    'packages/db-stubs',
  ]);
});

test('the committed railway/*.json watch every workspace dir their Dockerfile copies', () => {
  assert.deepEqual(railwayWatchProblems(REPO_ROOT), []);
});

test('the issue #170 cases: storage is watched by every service that builds it', () => {
  for (const svc of ['worker', 'bill-api', 'banter-api', 'bin-api', 'bay-api', 'blip-api']) {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'railway', `${svc}.json`), 'utf8'));
    assert.ok(cfg.build.watchPatterns.includes('packages/storage/**'), `${svc} must watch packages/storage/**`);
  }
});

test('the check reports a Dockerfile-copied package missing from the watch list', () => {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'railway', 'bill-api.json'), 'utf8'));
  const without = cfg.build.watchPatterns.filter((p) => p !== 'packages/storage/**');
  const copied = dockerfileCopiedDirs(readFileSync(join(REPO_ROOT, cfg.build.dockerfilePath), 'utf8'));
  const missing = copied.filter((d) => !without.includes(`${d}/**`));
  assert.deepEqual(missing, ['packages/storage']);
});
