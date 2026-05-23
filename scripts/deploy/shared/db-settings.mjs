// SuperUser-managed deploy settings loader.
//
// Reads the four `deploy_*` keys out of the running stack's
// `system_settings` table via `docker compose exec postgres psql`. This
// runs OUTSIDE the container set — postgres' credentials are read from
// the .env file at the repo root.
//
// Returns null entirely if anything goes wrong (postgres unreachable,
// stack down, .env missing, parse error, etc.). Callers MUST tolerate a
// null return and fall back to hardcoded defaults; that's the whole
// point of this being a soft overlay rather than a hard prerequisite.
//
// See docs/plans/deploy-settings-contract.md for the storage contract.
//
// Zero dependencies beyond node:child_process + node:fs.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ENV_FILE = '.env';
const QUERY_TIMEOUT_MS = 5_000;

// The four keys we care about. Anything else in system_settings is
// owned by other parts of the platform; we don't peek at them.
const KNOWN_KEYS = new Set([
  'deploy_branch',
  'deploy_repo_url',
  'deploy_github_token',
  'deploy_auto_update_enabled',
]);

/**
 * Parse a single key=value line from a .env file. Strips surrounding
 * double or single quotes and trims trailing whitespace. Returns null
 * if the line doesn't match the expected shape.
 */
function parseEnvLine(line) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (!m) return null;
  let value = m[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key: m[1], value };
}

/**
 * Read the bits of .env we need to authenticate to postgres. Returns
 * null if the file is missing or any required key is absent.
 *
 * Exposed for tests so the parsing logic can be exercised directly.
 */
export function loadPostgresEnv(cwd = process.cwd()) {
  const envPath = path.resolve(cwd, ENV_FILE);
  if (!fs.existsSync(envPath)) return null;
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) map[parsed.key] = parsed.value;
  }
  const user = map.POSTGRES_USER;
  const password = map.POSTGRES_PASSWORD;
  const db = map.POSTGRES_DB;
  if (!user || !password || !db) return null;
  return { user, password, db };
}

/**
 * Parse the psql tuples-only / pipe-separated output into a key→value
 * map. The query returns rows like:
 *
 *   deploy_branch|"stable"
 *   deploy_auto_update_enabled|true
 *
 * `value` is JSONB, so each value is a JSON literal we parse with
 * JSON.parse. Rows that fail to parse are skipped silently — better to
 * fall back to defaults than to crash the deploy script over malformed
 * data the SuperUser UI shouldn't have written in the first place.
 *
 * Exposed for tests.
 */
export function parsePsqlOutput(stdout) {
  const result = {
    deploy_branch: null,
    deploy_repo_url: null,
    deploy_github_token_encrypted: null,
    deploy_auto_update_enabled: true, // contract default when row absent
  };
  if (typeof stdout !== 'string') return result;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split only on the FIRST pipe — JSON values may legally contain pipes
    // (e.g. inside a string). The key column is well-defined snake_case so
    // it never contains one.
    const sepIdx = line.indexOf('|');
    if (sepIdx < 0) continue;
    const key = line.slice(0, sepIdx);
    const rawValue = line.slice(sepIdx + 1);
    if (!KNOWN_KEYS.has(key)) continue;

    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      continue;
    }

    switch (key) {
      case 'deploy_branch':
        if (typeof parsed === 'string' && parsed.length > 0) {
          result.deploy_branch = parsed;
        }
        break;
      case 'deploy_repo_url':
        if (typeof parsed === 'string' && parsed.length > 0) {
          result.deploy_repo_url = parsed;
        } else if (parsed === null) {
          result.deploy_repo_url = null;
        }
        break;
      case 'deploy_github_token':
        if (typeof parsed === 'string' && parsed.startsWith('enc:')) {
          result.deploy_github_token_encrypted = parsed;
        } else if (parsed === null) {
          result.deploy_github_token_encrypted = null;
        }
        break;
      case 'deploy_auto_update_enabled':
        if (typeof parsed === 'boolean') {
          result.deploy_auto_update_enabled = parsed;
        }
        break;
    }
  }
  return result;
}

/**
 * Default `execFileSync`-style runner that the loader uses to invoke
 * docker compose. Returns the trimmed stdout string on success. Throws
 * on any error (non-zero exit, timeout, docker missing, etc.).
 *
 * Extracted into a thin wrapper so tests can inject a mock without
 * touching child_process directly.
 */
function defaultPsqlRunner({ user, password, db, sql }) {
  // Use execFileSync with array-form args so the postgres user / db /
  // SQL never go through a shell — no interpolation risk even if a
  // setting key were to contain shell metacharacters. (Keys come from
  // the contract anyway, but defense in depth is cheap here.)
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `PGPASSWORD=${password}`,
      'postgres',
      'psql',
      '-U',
      user,
      '-d',
      db,
      '-t',
      '-A',
      '-F',
      '|',
      '-c',
      sql,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
    },
  );
}

/**
 * Fetch the four SuperUser-configurable deploy settings from the
 * running stack's postgres. Returns null if anything blocks the read
 * (postgres unreachable, missing .env, docker not installed, etc.).
 *
 * Shape on success:
 * ```
 * {
 *   deploy_branch: string | null,                  // null → use hardcoded default
 *   deploy_repo_url: string | null,
 *   deploy_github_token_encrypted: string | null,  // 'enc:...' or null
 *   deploy_auto_update_enabled: boolean,           // default true
 * }
 * ```
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - working directory for .env lookup (default: process.cwd()).
 * @param {(args: { user: string, password: string, db: string, sql: string }) => string} [options.runner]
 *   - Optional psql runner override (tests inject this). Must return the
 *     raw stdout string.
 */
export async function loadDeploySettings(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? defaultPsqlRunner;

  const env = loadPostgresEnv(cwd);
  if (!env) return null;

  const sql = "SELECT key, value FROM system_settings WHERE key LIKE 'deploy\\_%'";
  let stdout;
  try {
    stdout = runner({ user: env.user, password: env.password, db: env.db, sql });
  } catch {
    // Stack down, postgres unreachable, docker not installed, timeout,
    // psql refused auth, etc. Returning null lets the deploy script
    // fall through to hardcoded defaults silently.
    return null;
  }

  return parsePsqlOutput(stdout ?? '');
}

// CLI smoke entry point: `node scripts/deploy/shared/db-settings.mjs`
// Prints the loaded settings (or null) as JSON. Handy for verifying the
// connection bits work without spinning up the full deploy script.
//
// Detect "run as main" via fileURLToPath to dodge the Windows
// backslash/forward-slash mismatch between import.meta.url (always
// posix-style file:// URL) and process.argv[1] (native path separators).
{
  let runAsMain = false;
  try {
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(import.meta.url);
    if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here)) {
      runAsMain = true;
    }
  } catch {
    // ignore — not running as main
  }
  if (runAsMain) {
    loadDeploySettings()
      .then((settings) => {
        // Mask the token if present so the smoke output never leaks
        // ciphertext into a terminal scrollback.
        if (settings?.deploy_github_token_encrypted) {
          settings.deploy_github_token_encrypted = '[REDACTED enc:...]';
        }
        process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
      })
      .catch((err) => {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        process.exitCode = 1;
      });
  }
}
