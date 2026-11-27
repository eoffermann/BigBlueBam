#!/usr/bin/env node
// Bounded, observable workspace typecheck for CI (#335). See scripts/lib/typecheck-runner.mjs.
//
// Usage: node scripts/ci/typecheck-all.mjs [--concurrency N] [--shard i/n] [--timeout-min M]
// Env equivalents: TYPECHECK_CONCURRENCY, TYPECHECK_SHARD, TYPECHECK_PACKAGE_TIMEOUT_MIN.

import { spawn } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverTypecheckPackages,
  formatSeconds,
  parseShard,
  runPool,
  shardItems,
} from '../lib/typecheck-runner.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const startedAt = Date.now();

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Every line is written synchronously so it survives even if the runner is killed.
function log(msg) {
  process.stdout.write(`[typecheck +${formatSeconds(Date.now() - startedAt)}] ${msg}\n`);
}

function memLine() {
  const mb = (b) => Math.round(b / 1024 / 1024);
  return `free ${mb(freemem())} MB of ${mb(totalmem())} MB`;
}

const concurrency = Number(arg('concurrency') ?? process.env.TYPECHECK_CONCURRENCY ?? 4);
const shard = parseShard(arg('shard') ?? process.env.TYPECHECK_SHARD);
const timeoutMin = Number(arg('timeout-min') ?? process.env.TYPECHECK_PACKAGE_TIMEOUT_MIN ?? 8);

const all = discoverTypecheckPackages(ROOT);
const pkgs = shardItems(all, shard);
log(
  `${pkgs.length} of ${all.length} package(s)${shard ? ` (shard ${shard.index}/${shard.total})` : ''}, ` +
    `concurrency ${concurrency}, per-package timeout ${timeoutMin} min; ${memLine()}`,
);

const running = new Map();
const heartbeat = setInterval(() => {
  const now = Date.now();
  const list = [...running.entries()].map(([dir, t]) => `${dir} (${formatSeconds(now - t)})`);
  log(`still running: ${list.join(', ') || 'none'}; ${memLine()}`);
}, 30_000);

function typecheck(pkg) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    running.set(pkg.dir, t0);
    log(`START  ${pkg.dir}`);
    const child = spawn('pnpm', ['run', '--silent', 'typecheck'], {
      cwd: join(ROOT, pkg.dir),
      shell: process.platform === 'win32',
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`TIMEOUT ${pkg.dir} after ${timeoutMin} min; killing it`);
      child.kill('SIGKILL');
    }, timeoutMin * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(pkg.dir);
      const ok = code === 0 && !timedOut;
      log(`${ok ? 'OK    ' : 'FAIL  '} ${pkg.dir} in ${formatSeconds(Date.now() - t0)}${ok ? '' : ` (exit ${code}${timedOut ? ', timed out' : ''})`}`);
      if (!ok && output.trim()) process.stdout.write(`${output.trimEnd()}\n`);
      resolve({ ok, dir: pkg.dir, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      running.delete(pkg.dir);
      log(`FAIL   ${pkg.dir}: ${err.message}`);
      resolve({ ok: false, dir: pkg.dir, timedOut: false });
    });
  });
}

const results = await runPool(pkgs, concurrency, typecheck);
clearInterval(heartbeat);
const failed = results.filter((r) => !r?.ok);
log(`done: ${results.length - failed.length} passed, ${failed.length} failed; ${memLine()}`);
if (failed.length > 0) {
  log(`failed: ${failed.map((r) => r.dir ?? String(r.error)).join(', ')}`);
  process.exit(1);
}
