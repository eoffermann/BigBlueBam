#!/usr/bin/env node
//
// up.mjs — start the BigBlueBam local Docker dev stack.
//
// Pure stack runner. Requires .env to already exist; does NOT compose .env
// itself (use scripts/dev/configure.sh for that). Runs `docker compose up -d`
// which auto-merges any docker-compose.override.yml present (gitignored,
// per-developer file managed by scripts/dev/compose-overrides.sh). Without
// an override file, every service runs from its prod image. With an
// override file, the named services run with bind-mounted source +
// tsup-watch + node --watch for hot reload.
//
// This is the local-dev counterpart to deploy.sh — that one builds
// production images, pins NODE_ENV=production, and prompts for TLS. Use
// scripts/deploy.sh for real deployments; use this for daily dev work.
//
// Usage:
//   node scripts/dev/up.mjs
//
// Or via VS Code: Cmd+Shift+P → Tasks: Run Task → "Dev: Up"
//
// If .env is missing: this script fails fast and points you at
// ./scripts/dev/configure.sh (interactive) or ./scripts/dev/configure.sh -y (auto).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  assertRepoRoot,
  assertDockerRunning,
  assertEnvFile,
} from '../lib/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
process.chdir(repoRoot);

function preflight() {
  assertRepoRoot();
  assertEnvFile();
  assertDockerRunning();
  console.log('[ok] Pre-flight: repo root + .env present + Docker daemon reachable.');
}

function bringUp() {
  // Just `docker compose up -d`. Compose auto-merges docker-compose.override.yml
  // if it exists (managed by scripts/dev/compose-overrides.sh). Without an
  // override file, every service runs from its prod image. --build is added so
  // any service that an override file declares with `build:` gets rebuilt to
  // pick up Dockerfile or source changes.
  console.log('Starting dev stack (docker compose up -d --build)...');
  const result = spawnSync(
    'docker',
    ['compose', 'up', '-d', '--build'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error('[fail] docker compose up failed. See output above.');
    process.exit(1);
  }
  console.log('[ok] docker compose up complete.');
}

async function waitForApiHealthy(maxSeconds = 120) {
  process.stdout.write('Waiting for api to become healthy ');
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const ps = spawnSync(
      'docker',
      ['compose', 'ps', 'api', '--format', 'json'],
      { encoding: 'utf8' },
    );
    if (ps.status === 0 && ps.stdout) {
      try {
        const lines = ps.stdout.trim().split('\n').filter(Boolean);
        const obj = lines.length ? JSON.parse(lines[0]) : null;
        const status = obj ? `${obj.Status ?? ''} ${obj.State ?? ''} ${obj.Health ?? ''}` : '';
        if (/healthy/i.test(status)) {
          process.stdout.write(' [ok]\n');
          return true;
        }
      } catch {
        // compose ps json output not parseable yet — keep polling
      }
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write(' [fail]\n');
  console.error('  api never reached healthy state. Inspect with: docker compose logs api');
  return false;
}

function banner() {
  let httpPort = '80';
  try {
    const env = fs.readFileSync('.env', 'utf8');
    const m = env.match(/^HTTP_PORT=(.*)$/m);
    if (m) httpPort = m[1].trim();
  } catch {
    // .env not readable — banner falls back to default port
  }
  const portSuffix = httpPort === '80' ? '' : `:${httpPort}`;
  console.log('');
  console.log('  Dev stack is up.');
  console.log('');
  console.log(`    Bootstrap (first run): http://localhost${portSuffix}/b3/bootstrap`);
  console.log(`    Bam SPA:               http://localhost${portSuffix}/b3/`);
  console.log('');
  console.log('    Logs:  docker compose logs -f api');
  console.log('    Stop:  docker compose stop');
  console.log('    Wipe:  ./scripts/dev/decommission.sh');
  console.log('');
}

preflight();
bringUp();
const ok = await waitForApiHealthy();
banner();
process.exit(ok ? 0 : 1);
