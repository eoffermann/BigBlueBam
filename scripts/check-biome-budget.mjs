#!/usr/bin/env node
/**
 * check-biome-budget.mjs (issue #132)
 *
 * Biome rules such as noNonNullAssertion and noExplicitAny are set to `warn`,
 * so `pnpm lint` stays green no matter how many warnings pile up. This script
 * is the ratchet: it runs each workspace package's own Biome lint command with
 * the JSON reporter, counts warnings per package, and compares the counts with
 * the committed baseline in scripts/biome-warning-budget.json.
 *
 *   node scripts/check-biome-budget.mjs           # fail if any package went UP
 *   node scripts/check-biome-budget.mjs --update  # rewrite the baseline to the
 *                                                 # current counts (refuses to
 *                                                 # raise a count unless --allow-increase)
 *
 * When a package's count drops, the check still passes and prints the exact
 * command to lower the baseline, so the next increase is caught at the new level.
 * A package with no baseline entry fails until it is added with --update.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILE = join(ROOT, 'scripts', 'biome-warning-budget.json');
const BIOME_BIN = join(ROOT, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');
const CONCURRENCY = 6;
const started = Date.now();

const update = process.argv.includes('--update');
const allowIncrease = process.argv.includes('--allow-increase');

function log(msg) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`[biome-budget +${secs}s] ${msg}\n`);
}

/** Workspace packages whose `lint` script is a Biome command. */
function discoverPackages() {
  const pkgs = [];
  for (const group of ['apps', 'packages']) {
    const base = join(ROOT, group);
    for (const dir of readdirSync(base).sort()) {
      const pj = join(base, dir, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, 'utf8'));
      const lint = pkg.scripts?.lint;
      if (!lint || !/^biome\s/.test(lint)) continue;
      pkgs.push({ name: pkg.name, dir: join(base, dir), args: lint.split(/\s+/).slice(1) });
    }
  }
  return pkgs;
}

/** Run the package's Biome command with the JSON reporter; resolve to its warning count. */
function countWarnings(pkg) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [BIOME_BIN, ...pkg.args, '--reporter=json', '--max-diagnostics=0'],
      { cwd: pkg.dir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => {
      const start = out.indexOf('{"summary"');
      if (start < 0) {
        reject(new Error(`${pkg.name}: no Biome JSON summary in output`));
        return;
      }
      try {
        const report = JSON.parse(out.slice(start).trim().split('\n')[0]);
        resolvePromise(report.summary.warnings);
      } catch (e) {
        reject(new Error(`${pkg.name}: could not parse Biome JSON (${e.message})`));
      }
    });
  });
}

async function measureAll(pkgs) {
  const counts = {};
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < pkgs.length) {
      const pkg = pkgs[next++];
      counts[pkg.name] = await countWarnings(pkg);
      done++;
      log(`${String(done).padStart(2)}/${pkgs.length} ${pkg.name}: ${counts[pkg.name]} warning(s)`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
}

async function main() {
  if (!existsSync(BIOME_BIN)) {
    console.error(`Biome not installed at ${BIOME_BIN}; run pnpm install first.`);
    process.exit(1);
  }
  const pkgs = discoverPackages();
  log(`running Biome in ${pkgs.length} package(s), ${CONCURRENCY} at a time (takes a minute or two)`);
  const current = await measureAll(pkgs);
  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : {};

  const increased = [];
  const decreased = [];
  const missing = [];
  for (const [name, count] of Object.entries(current)) {
    if (!(name in baseline)) missing.push(`${name}: ${count}`);
    else if (count > baseline[name]) increased.push(`${name}: ${baseline[name]} -> ${count} (+${count - baseline[name]})`);
    else if (count < baseline[name]) decreased.push(`${name}: ${baseline[name]} -> ${count}`);
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  const budget = Object.values(baseline).reduce((a, b) => a + b, 0);
  log(`total warnings: ${total} (baseline ${budget})`);

  if (update) {
    if (increased.length && !allowIncrease) {
      console.error('Refusing to raise the baseline for:');
      for (const s of increased) console.error(`  ${s}`);
      console.error('Fix the new warnings, or rerun with --update --allow-increase if raising it is a deliberate decision.');
      process.exit(1);
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`);
    log(`wrote ${BASELINE_FILE}`);
    return;
  }

  let failed = false;
  if (increased.length) {
    failed = true;
    console.error('FAIL: Biome warnings went up in:');
    for (const s of increased) console.error(`  ${s}`);
    console.error('Fix the new warnings (run `pnpm --filter <package> lint` to see them).');
  }
  if (missing.length) {
    failed = true;
    console.error('FAIL: packages with no entry in scripts/biome-warning-budget.json:');
    for (const s of missing) console.error(`  ${s}`);
    console.error('Add them with: node scripts/check-biome-budget.mjs --update');
  }
  if (decreased.length) {
    log('warnings went down (thank you) in:');
    for (const s of decreased) log(`  ${s}`);
    log('lock in the lower counts with: node scripts/check-biome-budget.mjs --update');
  }
  if (!failed) log('PASS: no package exceeds its Biome warning budget.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
