// Bounded, observable `typecheck` across the workspace (#335, after #235).
//
// CI used `pnpm -r --parallel --if-present typecheck`, which starts a tsc for every one of
// ~66 packages at once. On a hosted runner that plausibly exhausts memory and starves the
// runner agent: three times the step hung past its own timeout, the job was reaped late and
// no log blob survived, so nobody could tell which package stalled. This runner:
//   - runs at most `concurrency` typechecks at a time (and can shard the list across jobs),
//   - prints a start and a finish line per package as it happens, with elapsed time,
//   - prints a heartbeat naming every still-running package plus free memory,
//   - kills a package that exceeds its own timeout and names it, so a hang is attributed.
// The pure parts (discovery, sharding, the pool) are unit-tested in typecheck-runner.test.mjs.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Workspace packages (apps/*, packages/*) that define a `typecheck` script, sorted by dir. */
export function discoverTypecheckPackages(root, groups = ['apps', 'packages']) {
  const out = [];
  for (const group of groups) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const pj = join(base, name, 'package.json');
      if (!existsSync(pj)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pj, 'utf8'));
      } catch {
        continue;
      }
      if (pkg?.scripts?.typecheck) out.push({ name: pkg.name ?? `${group}/${name}`, dir: `${group}/${name}` });
    }
  }
  return out;
}

/** Parse "i/n" (1-based). Returns null for an empty value; throws on a malformed one. */
export function parseShard(value) {
  if (value === undefined || value === null || value === '') return null;
  const m = String(value).trim().match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error(`Invalid shard "${value}" (expected i/n, e.g. 1/2)`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new Error(`Invalid shard "${value}"`);
  return { index, total };
}

/** Round-robin split, deterministic: every item lands in exactly one shard. */
export function shardItems(items, shard) {
  if (!shard) return items.slice();
  return items.filter((_, i) => i % shard.total === shard.index - 1);
}

/**
 * Run `task(item)` for every item with at most `concurrency` in flight. Resolves with the
 * results in input order. A task that throws is recorded as { ok: false, error }.
 */
export async function runPool(items, concurrency, task) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await task(items[i], i);
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}
