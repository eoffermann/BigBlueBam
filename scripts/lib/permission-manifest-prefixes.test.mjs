// node --test scripts/lib/permission-manifest-prefixes.test.mjs
//
// Issue #146: the permission-manifest generator derives its app prefixes from the
// apps/<dir>/src/routes directories and fails on any directory it cannot classify,
// instead of silently dropping a new app's routes from the catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverAppPrefixes } from '../generate-permission-manifest.mjs';

function fakeApps(dirs) {
  const root = mkdtempSync(join(tmpdir(), 'perm-prefixes-'));
  for (const d of dirs) mkdirSync(join(root, d, 'src', 'routes'), { recursive: true });
  return root;
}

// Every NOT_ROUTE_SCANNED entry must exist, so a fixture carries all of them.
const SKIPPED = [
  'blip-api',
  'basis-api',
  'braid-api',
  'bulwark-api',
  'burn-api',
  'bursar-api',
  'blueprint-api',
  'bureau-api',
  'bastion-api',
  'mcp-server',
];

test('the real repo classifies every route directory, with the historical prefixes', () => {
  const map = discoverAppPrefixes();
  assert.equal(map.api, 'bam');
  assert.equal(map['bill-api'], 'bill');
  assert.equal(map['helpdesk-api'], 'helpdesk');
  for (const s of SKIPPED) assert.ok(!(s in map), `${s} must not be route-scanned`);
  assert.deepEqual(
    Object.values(map).sort(),
    ['bam', 'banter', 'bay', 'beacon', 'bearing', 'bench', 'bill', 'bin', 'blank', 'blast', 'board', 'bolt', 'bond', 'book', 'brief', 'helpdesk'].sort(),
  );
});

test('a new <app>-api directory is picked up automatically', () => {
  const root = fakeApps(['api', 'newapp-api', ...SKIPPED]);
  try {
    assert.deepEqual(discoverAppPrefixes(root), { api: 'bam', 'newapp-api': 'newapp' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a route directory that maps to no prefix fails the generator', () => {
  const root = fakeApps(['api', 'oddly-named', ...SKIPPED]);
  try {
    assert.throws(() => discoverAppPrefixes(root), /apps\/oddly-named\/src\/routes maps to no permission prefix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a classified app with no routes yet is allowed (ids registered ahead of routes)', () => {
  const root = fakeApps(['api', ...SKIPPED.filter((d) => d !== 'bastion-api')]);
  try {
    mkdirSync(join(root, 'bastion-api'), { recursive: true });
    writeFileSync(join(root, 'bastion-api', 'package.json'), '{}');
    assert.deepEqual(discoverAppPrefixes(root), { api: 'bam' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale NOT_ROUTE_SCANNED entry fails the generator', () => {
  const root = fakeApps(['api', ...SKIPPED.filter((d) => d !== 'bureau-api')]);
  try {
    assert.throws(() => discoverAppPrefixes(root), /NOT_ROUTE_SCANNED lists "bureau-api"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
