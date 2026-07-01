#!/usr/bin/env node
// railway-auto-deploy.mjs — non-interactive Railway reconcile for CI.
//
// PURPOSE (parity with local `docker compose up`):
//   Locally, adding a service to docker-compose.yml + `docker compose up`
//   creates it — zero manual steps. On Railway there was no equivalent, so a
//   NEW app (blip-api, bay-api, …) needed the operator to hand-create the
//   service in the dashboard before it could ever deploy. This script closes
//   that gap: it reconciles the live Railway project against the
//   `scripts/deploy/shared/services.mjs` catalog, CREATES every service that
//   does not yet exist, wires it exactly the way the interactive deploy would,
//   triggers its first deploy, and redeploys the public ingress (frontend) so
//   its nginx routes + SPA bundle expose the new app.
//
//   It is a pure function of the catalog + Railway's live state, so it runs
//   headlessly from a SINGLE credential (a Railway API token) with no prompts.
//   The one class of value it cannot derive from the catalog — shared secrets
//   that must be IDENTICAL across services (SESSION_SECRET, INTERNAL_*,
//   MINIO_*, LIVEKIT_*) — it READS off an already-deployed service and copies
//   forward, so no secret ever has to live in CI. Service-local secrets that
//   nothing else references (e.g. BLIP_INGEST_PEPPER) are generated fresh.
//
// USAGE:
//   node scripts/deploy/railway-auto-deploy.mjs            # dry-run (default)
//   node scripts/deploy/railway-auto-deploy.mjs --apply    # actually mutate
//
// ENV (all optional except the token):
//   RAILWAY_API_TOKEN / RAILWAY_TOKEN  Railway credential (account API token
//                                      preferred — it does not expire).
//   RAILWAY_PROJECT_NAME               default: "bigbluebam"
//   RAILWAY_DEPLOY_BRANCH              default: "stable"
//   RAILWAY_GITHUB_REPO                default: $GITHUB_REPOSITORY or git remote
//   RAILWAY_WORKSPACE_ID               optional workspace scope
//   PUBLIC_URL                         ingress base URL for `public`-kind vars
//
// Progress is logged verbosely and flushed (per the user-wide logging rule):
// every phase prints a line so a long provisioning run is never silent.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { RailwayClient } from './shared/railway-api.mjs';
import { RailwayOrchestrator } from './shared/railway-orchestrator.mjs';
import { hintFor } from './shared/env-hints.mjs';
import { APP_SERVICES, INFRA_SERVICES, JOB_SERVICES } from './shared/services.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const t0 = Date.now();
function log(msg) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`[auto-deploy +${secs}s] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\n[auto-deploy] ERROR: ${msg}\n`);
  process.exit(1);
}

// ─── Resolve configuration (env → state file → defaults) ──────────────

function readStateFile() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, '.deploy-state-railway.json'), 'utf8'));
  } catch {
    return null;
  }
}

function readTokenFromEnvFile() {
  try {
    const text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
    const m = text.match(/^RAILWAY_API_TOKEN=(.*)$/m) || text.match(/^RAILWAY_TOKEN=(.*)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function detectGithubRepo() {
  if (process.env.RAILWAY_GITHUB_REPO) return process.env.RAILWAY_GITHUB_REPO;
  // GitHub Actions sets this to "owner/repo" for free.
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execSync('git config --get remote.origin.url', { cwd: REPO_ROOT }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) return m[1];
  } catch {
    /* not a git checkout — fall through */
  }
  return null;
}

// ─── Secret sourcing ──────────────────────────────────────────────────
//
// Which env keys are `secret`-kind across the whole catalog. Everything else
// is plugin/reference/computed/literal (Railway resolves it) or public/user
// (skipped for a fresh *-api service that does not need them).
function secretKeyCatalog() {
  const keys = new Set();
  const all = [...APP_SERVICES, ...INFRA_SERVICES, ...JOB_SERVICES];
  for (const svc of all) {
    for (const name of [...(svc.env?.required ?? []), ...(svc.env?.optional ?? [])]) {
      if (hintFor(name).kind === 'secret') keys.add(name);
    }
  }
  return keys;
}

// The services we prefer to read shared secrets off, in priority order. `api`
// carries SESSION_SECRET + INTERNAL_*; `minio` carries MINIO_*; `livekit`
// carries LIVEKIT_*. First value wins so a shared secret is copied verbatim.
const SECRET_SOURCE_SERVICES = ['api', 'minio', 'livekit', 'helpdesk-api', 'banter-api'];

async function collectSharedSecrets(client, { projectId, environmentId, liveByName }) {
  const wanted = secretKeyCatalog();
  const collected = {};
  for (const name of SECRET_SOURCE_SERVICES) {
    const serviceId = liveByName.get(name);
    if (!serviceId) continue;
    let vars;
    try {
      vars = await client.getServiceVariables({ projectId, environmentId, serviceId });
    } catch (err) {
      log(`  (could not read variables off "${name}": ${err?.message ?? err})`);
      continue;
    }
    for (const key of wanted) {
      if (collected[key] === undefined && vars[key] !== undefined && vars[key] !== '') {
        collected[key] = vars[key];
      }
    }
  }
  return collected;
}

// For every service the catalog says is MISSING on Railway, ensure each of its
// required secret-kind vars has a value: prefer the shared one we just copied,
// else GENERATE a fresh 32-byte hex secret (safe only for service-local
// secrets that nothing else references — a brand-new service has no peers that
// need to agree on the value yet).
function fillMissingSecrets(collected, missingServices) {
  const generated = [];
  for (const svc of missingServices) {
    for (const name of svc.env?.required ?? []) {
      if (hintFor(name).kind !== 'secret') continue;
      if (collected[name] === undefined || collected[name] === '') {
        collected[name] = randomBytes(32).toString('hex');
        generated.push(`${name} (for ${svc.name})`);
      }
    }
  }
  return generated;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes('--apply');
  const state = readStateFile();

  const token =
    process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN || readTokenFromEnvFile();
  if (!token) {
    fail(
      'No Railway credential. Set RAILWAY_API_TOKEN (account API token, preferred — ' +
        'it does not expire) in the environment or .env. In CI add it as the ' +
        'RAILWAY_API_TOKEN repository secret.',
    );
  }

  const projectName =
    process.env.RAILWAY_PROJECT_NAME || state?.project?.name || 'bigbluebam';
  const branch =
    process.env.RAILWAY_DEPLOY_BRANCH || state?.source?.branch || 'stable';
  const githubRepo =
    detectGithubRepo() || state?.source?.github_repo || null;
  if (!githubRepo) {
    fail(
      'Could not determine the GitHub repo (owner/repo). Set RAILWAY_GITHUB_REPO ' +
        'or run inside the git checkout / GitHub Actions.',
    );
  }
  const workspaceId = process.env.RAILWAY_WORKSPACE_ID || null;
  const publicUrl = process.env.PUBLIC_URL || state?.source?.public_url || null;

  log(`Mode: ${apply ? 'APPLY (will create + deploy)' : 'DRY RUN (read-only)'}`);
  log(`Project: "${projectName}"  Branch: ${branch}  Repo: ${githubRepo}`);
  if (publicUrl) log(`Public URL: ${publicUrl}`);

  const client = new RailwayClient(token);

  // Validate the token early with a clear message — this is the single
  // credential the whole flow depends on.
  log('Validating Railway API token…');
  let me;
  try {
    me = await client.whoami();
  } catch (err) {
    fail(
      `Railway token rejected (${err?.message ?? err}). Generate a fresh account ` +
        `API token at Railway → Account Settings → Tokens and set RAILWAY_API_TOKEN.`,
    );
  }
  log(`Authenticated as ${me.email ?? me.name ?? 'unknown'}`);

  // Resolve the project + default environment so we can read shared secrets
  // off a live service before provisioning.
  log(`Resolving project "${projectName}"…`);
  let project = await client.findProjectByName(projectName, { workspaceId });
  if (!project && !workspaceId) {
    // Fall back to scanning every workspace the token can see.
    const workspaces = await client.listWorkspaces().catch(() => []);
    for (const ws of workspaces) {
      project = await client.findProjectByName(projectName, { workspaceId: ws.id }).catch(() => null);
      if (project) break;
    }
  }
  if (!project) {
    fail(
      `No Railway project named "${projectName}" is visible to this token. ` +
        `Check RAILWAY_PROJECT_NAME and that the token belongs to the right workspace.`,
    );
  }
  const env = await client.getDefaultEnvironment(project.id);
  log(`Project ${project.id} — environment ${env.id}`);

  const liveServices = await client.listServices(project.id);
  const liveByName = new Map(liveServices.map((s) => [s.name, s.id]));
  log(`Railway has ${liveServices.length} services live.`);

  // Copy shared secrets forward off the live stack.
  log('Reading shared secrets off the live stack…');
  const generatedSecrets = await collectSharedSecrets(client, {
    projectId: project.id,
    environmentId: env.id,
    liveByName,
  });
  const copied = Object.keys(generatedSecrets);
  log(`  copied ${copied.length} shared secret(s): ${copied.join(', ') || '(none)'}`);

  // Determine which catalog services are missing, and top up their required
  // secret-kind vars with freshly-generated values where none was copied.
  const requiredCatalog = APP_SERVICES.filter((s) => s.required && s.name !== 'voice-agent');
  const missing = [...requiredCatalog, ...INFRA_SERVICES.filter((i) => !i.managed_on_railway), ...JOB_SERVICES]
    .filter((s) => !liveByName.has(s.name));
  const gen = fillMissingSecrets(generatedSecrets, missing);
  if (gen.length) log(`  generated ${gen.length} fresh service-local secret(s): ${gen.join(', ')}`);

  if (missing.length === 0) {
    log('No missing services — every catalog service already exists on Railway.');
  } else {
    log(`Missing services to provision: ${missing.map((s) => s.name).join(', ')}`);
  }

  const orchestrator = new RailwayOrchestrator(client, {
    projectName,
    workspaceId,
    githubRepo,
    branch,
    generatedSecrets,
    publicUrl,
    userIntegrations: {},
    onProgress: (ev) => {
      if (ev?.message) log(`  ${ev.ok === false ? 'FAIL: ' : ''}${ev.message}`);
      if (ev?.warning && ev?.message) log(`  ⚠ ${ev.message}`);
    },
  });

  log(apply ? 'Provisioning missing services + triggering deploys…' : 'Computing plan (no writes)…');
  // Services to redeploy on EVERY run regardless of whether a new service was
  // created. Railway's GitHub integration already redeploys existing services
  // on push, so this is normally empty — but the ingress (frontend) has proven
  // it can miss an auto-deploy, and it is the one service that must reflect a
  // new app's nginx routes, so CI sets RAILWAY_ALWAYS_REDEPLOY=frontend as a
  // safety net. Comma-separated.
  const alwaysRedeploy = (process.env.RAILWAY_ALWAYS_REDEPLOY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (alwaysRedeploy.length) log(`Always-redeploy set: ${alwaysRedeploy.join(', ')}`);

  // Pass the pre-resolved project/environment so syncNew never re-resolves and
  // can never create a duplicate project.
  const summary = await orchestrator.syncNew({
    dryRun: !apply,
    projectId: project.id,
    environmentId: env.id,
    alwaysRedeploy,
  });

  log('─'.repeat(60));
  log(
    apply
      ? `Done: created ${summary.provisioned.length} service(s), triggered ${summary.deployed.length} deploy(s).`
      : `Dry run: would create ${summary.provisioned.length} service(s), trigger ${summary.deployed.length} deploy(s).`,
  );
  if (summary.provisioned.length) log(`  services: ${summary.provisioned.join(', ')}`);
  if (summary.deployed.length) log(`  deploys:  ${summary.deployed.join(', ')}`);
  if (!apply && (summary.provisioned.length || summary.deployed.length)) {
    log('Re-run with --apply to execute.');
  }
}

main().catch((err) => {
  fail(err?.stack ?? err?.message ?? String(err));
});
