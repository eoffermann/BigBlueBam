#!/usr/bin/env node
//
// configure/main.mjs — interactive .env composer for the LOCAL DOCKER dev
// posture. Composes .env for `docker compose ... up` on the developer's
// laptop. Does NOT bring up the stack (use scripts/dev/up.mjs for that).
// Does NOT cover SaaS dev deploys or DevOps-provisioned dev environments —
// those are different deployments and warrant separate scripts.
//
// Two modes share one core flow:
//   - interactive  ./scripts/dev/configure.sh
//   - auto         ./scripts/dev/configure.sh -y       (--yes / --non-interactive)
//
// Stateful keys (POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD) are tied to
// persistent volumes — once a volume is initialized with a password, that
// password is unrecoverable from the volume. We preserve those keys
// whenever the matching volume exists. If the volume exists but the
// password is missing from .env, abort with a clear recovery hint
// (decommission or restore from backup).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ask } from '../../deploy/shared/prompt.mjs';
import { bold, dim, check, red, green, cyan } from '../../deploy/shared/colors.mjs';
import {
  generateSecrets,
  buildEnvConfig,
  promptOptionalIntegrations,
} from '../../deploy/shared/secrets.mjs';
import { writeEnvFile } from '../../deploy/platforms/docker-compose.mjs';
import {
  assertRepoRoot,
  assertDockerRunning,
  parseEnvFile,
} from '../../lib/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
process.chdir(repoRoot);

const args = process.argv.slice(2);
const autoMode =
  args.includes('-y') || args.includes('--yes') || args.includes('--non-interactive');

const ENV_FILE = '.env';
const STATE_FILE = '.local-dev-state.json';

// Stateful password keys → corresponding Docker volume name. If the volume
// exists, the password is locked to whatever was there at first init.
const STATEFUL_VOLUMES = {
  POSTGRES_PASSWORD: 'bigbluebam_pgdata',
  MINIO_ROOT_PASSWORD: 'bigbluebam_miniodata',
};

// Minimum keys the env validators across the stack need to be set. Used by
// the auto-mode no-op shortcut: if .env already has all of these AND the
// stateful-volume check passes, we exit clean.
const REQUIRED_KEYS = [
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'DATABASE_URL',
  'REDIS_PASSWORD', 'REDIS_URL',
  'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD',
  'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET',
  'SESSION_SECRET',
  'INTERNAL_HELPDESK_SECRET',
  'INTERNAL_SERVICE_SECRET',
  'DOMAIN',
  'BASE_URL',
  'CORS_ORIGIN',
  'NODE_ENV',
];

// Integration keys we recognize. Anything in this list that's already in
// .env is preserved across re-runs (and shows in the redacted state file).
const INTEGRATION_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
];

function preflight() {
  assertRepoRoot();
  assertDockerRunning();
}

function volumeExists(name) {
  const result = spawnSync(
    'docker',
    ['volume', 'ls', '-q', '--filter', `name=^${name}$`],
    { encoding: 'utf8' },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

function checkStatefulConsistency(existingEnv) {
  const findings = [];
  for (const [pwKey, volName] of Object.entries(STATEFUL_VOLUMES)) {
    if (volumeExists(volName)) {
      if (!existingEnv[pwKey]) {
        console.error('');
        console.error(red('[fail] Stateful volume mismatch.'));
        console.error('');
        console.error(`  Volume ${cyan(volName)} exists, but ${cyan(pwKey)} is missing from .env.`);
        console.error('  The password it was initialized with is unrecoverable from the volume.');
        console.error('');
        console.error('  Either:');
        console.error(`    - Restore .env from a backup that includes ${pwKey}`);
        console.error(`    - Or wipe the volume: ${cyan('./scripts/dev/decommission.sh -y')}`);
        console.error('');
        process.exit(1);
      }
      findings.push(`${pwKey} preserved (volume ${volName} exists)`);
    }
  }
  if (findings.length === 0) {
    console.log(`  ${dim('No stateful volumes present — fresh state.')}`);
  } else {
    for (const f of findings) console.log(`  ${check} ${dim(f)}`);
  }
}

function isComplete(existingEnv, existingState) {
  if (!REQUIRED_KEYS.every((k) => existingEnv[k] && existingEnv[k].length > 0)) return false;
  // Also require state.devAdmin to be present and unredacted. This blocks the
  // auto-mode no-op shortcut when state has stale [REDACTED] values from the
  // pre-migration layout, forcing a full run that rewrites state cleanly.
  const sda = existingState?.devAdmin || {};
  const usable = (v) => typeof v === 'string' && v.length > 0 && v !== '[REDACTED]';
  return usable(sda.DEV_ADMIN_EMAIL) && usable(sda.DEV_ADMIN_PASSWORD) && usable(sda.DEV_ADMIN_ORG_NAME);
}

function extractIntegrations(existingEnv) {
  const out = {};
  for (const k of INTEGRATION_KEYS) {
    if (existingEnv[k]) out[k] = existingEnv[k];
  }
  return out;
}

async function promptHttpPort(existingEnv) {
  const current = existingEnv.HTTP_PORT || '80';
  if (autoMode) return current;
  return await ask('HTTP port to expose on host:', current);
}

async function promptDomain(existingEnv) {
  const current = existingEnv.DOMAIN || 'localhost';
  if (autoMode) return current;
  return await ask('Domain (or "localhost" for laptop dev):', current);
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState({ domain, httpPort, integrations, devAdmin, autoMode: auto }) {
  const redactSensitive = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      out[k] = /PASS|SECRET|KEY/i.test(k) ? '[REDACTED]' : v;
    }
    return out;
  };
  const state = {
    schema: 1,
    posture: 'local-dev',
    lastRun: new Date().toISOString(),
    autoMode: auto,
    domain,
    httpPort: String(httpPort),
    integrations: redactSensitive(integrations),
    // devAdmin is intentionally NOT redacted: this is the canonical store
    // for these values (no longer mirrored to .env). The state file is
    // gitignored at the same level as .env, same threat model. Redacting
    // would defeat the lookup utility (cat .local-dev-state.json | jq .devAdmin).
    devAdmin: { ...(devAdmin || {}) },
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function banner({ envPath, httpPort }) {
  const portSuffix = String(httpPort) === '80' ? '' : `:${httpPort}`;
  console.log('');
  console.log(green('  .env composed for local Docker dev.'));
  console.log('');
  console.log(`    File: ${dim(envPath)}`);
  console.log('');
  console.log('  Next: bring up the stack');
  console.log(`    ${cyan('node scripts/dev/up.mjs')}`);
  console.log(`    ${dim('(or VS Code → Tasks: Run Task → "Dev: Up")')}`);
  console.log('');
  console.log('  Bootstrap URL once api is healthy:');
  console.log(`    ${cyan(`http://localhost${portSuffix}/b3/bootstrap`)}`);
  console.log('');
}

async function main() {
  preflight();

  console.log(bold('BigBlueBam — local Docker dev configuration'));
  console.log(dim(`  Mode: ${autoMode ? 'non-interactive (-y)' : 'interactive'}`));
  console.log('');

  const existingEnv = parseEnvFile(ENV_FILE);
  const hasExistingEnv = Object.keys(existingEnv).length > 0;
  const existingState = readState();

  console.log(dim('Stateful volume check...'));
  checkStatefulConsistency(existingEnv);

  // Auto-mode no-op shortcut: if .env is complete AND state has unredacted
  // devAdmin keys, exit clean. Otherwise fall through to do a full run that
  // migrates / regenerates as needed.
  if (autoMode && hasExistingEnv && isComplete(existingEnv, existingState)) {
    console.log('');
    console.log(green('[ok] .env is complete. No changes needed.'));
    process.exit(0);
  }

  // Secrets:
  //   - Stateful keys: preserve from existing .env (consistency verified above)
  //                    or generate fresh if no volume + no .env
  //   - Everything else: freshly generated each run (rotating these is harmless
  //                      in dev — at worst you log out)
  const fresh = generateSecrets();
  const secrets = { ...fresh };
  for (const pwKey of Object.keys(STATEFUL_VOLUMES)) {
    if (existingEnv[pwKey]) secrets[pwKey] = existingEnv[pwKey];
  }

  // Config knobs (interactive prompts use existing values as defaults).
  const httpPort = await promptHttpPort(existingEnv);
  const domain = await promptDomain(existingEnv);

  // Integrations: existing first, then re-prompt in interactive mode.
  let integrations = extractIntegrations(existingEnv);
  if (!autoMode) {
    const promptResult = await promptOptionalIntegrations();
    integrations = { ...integrations, ...promptResult };
  }

  // Build the canonical envConfig.
  const portMapping =
    String(httpPort) === '80'
      ? null
      : { ports: { HTTP_PORT: Number(httpPort) }, useTls: false };

  const envConfig = buildEnvConfig({
    secrets,
    storage: { storageProvider: 'minio' },
    vectorDb: { vectorProvider: 'qdrant-local' },
    livekit: { livekitProvider: 'livekit-local' },
    integrations,
    domain,
    portMapping,
    tlsConfig: null,
  });

  // Merge: preserve any custom keys the operator added to .env that aren't
  // part of our canonical set. envConfig wins for keys we manage.
  const merged = { ...existingEnv, ...envConfig };
  // If the user just chose the default port (80), strip any stale HTTP_PORT
  // from the merged result so the .env stays clean and compose's
  // ${HTTP_PORT:-80} default kicks in.
  if (String(httpPort) === '80') delete merged.HTTP_PORT;

  // Dev-admin scaffolding lives in .local-dev-state.json (canonical store) —
  // NOT in .env, since no docker-compose service consumes DEV_ADMIN_*.
  // Resolve in priority order:
  //   1. existing state file (the canonical store on re-runs)
  //   2. existing .env (one-time migration from the old layout)
  //   3. generate fresh (cold start)
  // Treat '[REDACTED]' as missing so old redacted state files migrate cleanly.
  const isUsable = (v) => v && v !== '[REDACTED]';
  const stateDevAdmin = existingState?.devAdmin || {};
  const devAdmin = {
    DEV_ADMIN_EMAIL:
      isUsable(stateDevAdmin.DEV_ADMIN_EMAIL) ? stateDevAdmin.DEV_ADMIN_EMAIL :
      isUsable(existingEnv.DEV_ADMIN_EMAIL) ? existingEnv.DEV_ADMIN_EMAIL :
      'admin@example.com',
    DEV_ADMIN_PASSWORD:
      isUsable(stateDevAdmin.DEV_ADMIN_PASSWORD) ? stateDevAdmin.DEV_ADMIN_PASSWORD :
      isUsable(existingEnv.DEV_ADMIN_PASSWORD) ? existingEnv.DEV_ADMIN_PASSWORD :
      crypto.randomBytes(24).toString('hex'),
    DEV_ADMIN_ORG_NAME:
      isUsable(stateDevAdmin.DEV_ADMIN_ORG_NAME) ? stateDevAdmin.DEV_ADMIN_ORG_NAME :
      isUsable(existingEnv.DEV_ADMIN_ORG_NAME) ? existingEnv.DEV_ADMIN_ORG_NAME :
      'Dev Workspace',
  };
  // One-time migration from the old layout: if .env still has DEV_ADMIN_*
  // keys, we've captured them above. Strip from .env so the file stays clean
  // (no docker-compose service consumes them).
  delete merged.DEV_ADMIN_EMAIL;
  delete merged.DEV_ADMIN_PASSWORD;
  delete merged.DEV_ADMIN_ORG_NAME;

  const envPath = writeEnvFile(merged);
  console.log('');
  console.log(`${green('[ok]')} .env written to ${dim(envPath)}.`);

  saveState({ domain, httpPort, integrations, devAdmin, autoMode });

  banner({ envPath, httpPort });
}

await main();
