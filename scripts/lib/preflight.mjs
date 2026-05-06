// preflight.mjs — Node parallel of scripts/lib/preflight.sh.
//
// Each helper exits the process (process.exit(1)) on failure with a
// clear message that matches the bash version verbatim, so callers don't
// have to thread error-handling and the failure UX is consistent across
// shell and Node entry points.
//
// Usage (from a script anywhere under scripts/):
//   import {
//     assertRepoRoot,
//     assertDockerRunning,
//     assertEnvFile,
//     parseEnvFile,
//     readEnvVar,
//   } from '../../lib/preflight.mjs';      // adjust depth to taste
//   assertRepoRoot();
//
// All assertions run against process.cwd(), so callers should chdir to
// the repo root before invoking.

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Lightweight `[fail]` formatting. Imports red() from the deploy/shared
// colors module so output matches the rest of the dev tooling.
import { red } from '../deploy/shared/colors.mjs';

function failExit(message, ...moreLines) {
  console.error(`${red('[fail]')} ${message}`);
  for (const line of moreLines) console.error(line);
  process.exit(1);
}

export function assertRepoRoot() {
  if (!fs.existsSync('docker-compose.yml') || !fs.existsSync('apps/api')) {
    failExit('Run from the BigBlueBam repository root (cwd missing docker-compose.yml or apps/api/).');
  }
}

export function assertDockerRunning() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (result.status !== 0) {
    failExit('Docker daemon not reachable. Start Docker Desktop and re-run.');
  }
}

export function assertEnvFile() {
  if (!fs.existsSync('.env')) {
    failExit(
      'No .env found. Configure the local Docker dev environment first:',
      '  Interactive:     ./scripts/dev/configure.sh',
      '  Non-interactive: ./scripts/dev/configure.sh -y',
    );
  }
}

/**
 * Parse a .env file into a key→value map. Lines starting with '#' are
 * skipped. Surrounding double or single quotes around the value are
 * stripped. Returns {} if the file doesn't exist.
 */
export function parseEnvFile(envPath = '.env') {
  if (!fs.existsSync(envPath)) return {};
  const text = fs.readFileSync(envPath, 'utf8');
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Read a single key from .env. Returns the value (with surrounding quotes
 * stripped) or empty string if absent.
 */
export function readEnvVar(key, envPath = '.env') {
  const env = parseEnvFile(envPath);
  return env[key] ?? '';
}
