// #335: the CI typecheck runner bounds concurrency and shards deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTypecheckPackages, parseShard, runPool, shardItems } from './typecheck-runner.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

test('discovers the workspace packages that define a typecheck script', () => {
  const pkgs = discoverTypecheckPackages(ROOT);
  const dirs = pkgs.map((p) => p.dir);
  assert.ok(dirs.includes('apps/api'));
  assert.ok(dirs.includes('packages/shared'));
  assert.ok(pkgs.length > 20, `expected many packages, got ${pkgs.length}`);
  assert.equal(new Set(dirs).size, dirs.length);
});

test('parseShard accepts i/n and rejects nonsense', () => {
  assert.equal(parseShard(''), null);
  assert.equal(parseShard(undefined), null);
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  assert.throws(() => parseShard('0/2'));
  assert.throws(() => parseShard('3/2'));
  assert.throws(() => parseShard('half'));
});

test('shards partition the list: every package in exactly one shard', () => {
  const items = Array.from({ length: 67 }, (_, i) => i);
  const a = shardItems(items, { index: 1, total: 2 });
  const b = shardItems(items, { index: 2, total: 2 });
  assert.equal(a.length + b.length, items.length);
  assert.deepEqual([...a, ...b].sort((x, y) => x - y), items);
  assert.deepEqual(shardItems(items, null), items);
});

test('runPool never exceeds its concurrency and keeps result order', async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await runPool(Array.from({ length: 30 }, (_, i) => i), 4, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    return n * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(results, Array.from({ length: 30 }, (_, i) => i * 2));
});

test('runPool records a throwing task instead of aborting the run', async () => {
  const results = await runPool([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.equal(results[0], 1);
  assert.equal(results[1].ok, false);
  assert.equal(results[2], 3);
});
