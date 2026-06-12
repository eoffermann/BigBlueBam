// One-off: provision bureau-api + blueprint-api on the existing Railway
// production project. They exist in the service catalog (services.mjs)
// but the project was last orchestrated 2026-04-13, before either app
// existed, and Railway auto-deploys never create new services.
//
// Usage:
//   node provision-missing-railway-services.mjs plan     # read-only
//   node provision-missing-railway-services.mjs apply    # create+configure+vars+deploy
//   node provision-missing-railway-services.mjs status   # deployment status + log tails
//
// Secrets policy: variable values are COPIED from existing sibling
// services (board-api, api, livekit) so SESSION_SECRET / LiveKit keys
// match the running stack. No secret value is ever printed — only key
// names and which donor they came from.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RailwayClient } from './scripts/deploy/shared/railway-api.mjs';
import { hintFor } from './scripts/deploy/shared/env-hints.mjs';
import { APP_SERVICES } from './scripts/deploy/shared/services.mjs';

const MODE = process.argv[2] ?? 'plan';
const TARGETS = ['bureau-api', 'blueprint-api'];
const DONORS = ['board-api', 'api', 'livekit'];

async function loadToken() {
  const cfgPath = join(homedir(), '.railway', 'config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  const token = cfg?.user?.token || cfg?.user?.accessToken;
  if (!token) throw new Error('No token in ~/.railway/config.json — run `railway login` first.');
  return token;
}

async function loadState() {
  const state = JSON.parse(await readFile('.deploy-state-railway.json', 'utf8'));
  return {
    projectId: state.project?.id ?? 'f40a3b50-aadd-4667-b6ff-5d47c0d1ee26',
    environmentId: state.environment?.id ?? 'fa74344c-eb64-421e-bb50-5380d5fb0fcd',
    githubRepo: state.source?.github_repo ?? 'eoffermann/BigBlueBam',
    branch: state.source?.branch ?? 'stable',
  };
}

async function fetchVariables(client, { projectId, environmentId, serviceId }) {
  const data = await client.query(
    `query vars($projectId: String!, $environmentId: String!, $serviceId: String) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
     }`,
    { projectId, environmentId, serviceId },
  );
  return data?.variables ?? {};
}

function buildVarsFromDonors(svc, donorMaps) {
  const wanted = [...(svc.env?.required ?? []), ...(svc.env?.optional ?? [])];
  const out = {};
  const provenance = {};
  const missing = [];
  for (const name of wanted) {
    let resolved;
    let source;
    for (const [donorName, map] of donorMaps) {
      if (map[name] !== undefined && map[name] !== '') {
        resolved = map[name];
        source = `copied from ${donorName}`;
        break;
      }
    }
    if (resolved === undefined) {
      const hint = hintFor(name);
      if (['plugin', 'reference', 'computed', 'literal'].includes(hint.kind)) {
        resolved = hint.value;
        source = `env-hints (${hint.kind})`;
      }
    }
    if (resolved === undefined && /_INTERNAL_URL$/.test(name)) {
      // Railway internal-DNS convention used across the stack:
      // BOLT_API_INTERNAL_URL -> http://bolt-api.railway.internal:8080
      let host = name.replace(/_INTERNAL_URL$/, '').toLowerCase().replace(/_/g, '-');
      if (!host.endsWith('-api')) host = `${host}-api`;
      resolved = `http://${host}.railway.internal:8080`;
      source = 'synthesized (railway.internal pattern)';
    }
    if (resolved === undefined) {
      if ((svc.env?.required ?? []).includes(name)) missing.push(name);
      continue;
    }
    out[name] = resolved;
    provenance[name] = source;
  }
  return { vars: out, provenance, missing };
}

const token = await loadToken();
const client = new RailwayClient(token);
const { projectId, environmentId, githubRepo, branch } = await loadState();

const me = await client.whoami();
console.log(`Authenticated as: ${me.email ?? me.name}`);

const services = await client.listServices(projectId);
console.log(`Project ${projectId}: ${services.length} services exist`);
const byName = new Map(services.map((s) => [s.name, s]));

if (MODE === 'status') {
  for (const name of [...TARGETS, 'migrate']) {
    const svc = byName.get(name);
    if (!svc) {
      console.log(`${name}: NOT PRESENT`);
      continue;
    }
    const deps = await client.listServiceDeployments({
      projectId, environmentId, serviceId: svc.id, limit: 1,
    });
    const d = deps[0];
    console.log(`${name}: ${d ? `${d.status} (created ${d.createdAt})` : 'no deployments'}`);
    if (d && ['FAILED', 'CRASHED'].includes(d.status)) {
      const logs = await client.fetchBuildLogs(d.id, { limit: 4000 });
      const tail = logs.slice(-25).map((l) => `  [build] ${l.message}`).join('\n');
      console.log(tail || '  (no build logs)');
      const rlogs = await client.fetchDeploymentLogs(d.id, { limit: 4000 });
      console.log(rlogs.slice(-25).map((l) => `  [run] ${l.message}`).join('\n') || '  (no runtime logs)');
    }
    if (name === 'migrate' && d) {
      const rlogs = await client.fetchDeploymentLogs(d.id, { limit: 5000 });
      const interesting = rlogs
        .map((l) => l.message)
        .filter((m) => /applied|already|migration|01[5-8][0-9]|error|fail/i.test(m))
        .slice(-30);
      console.log(interesting.map((m) => `  [migrate] ${m}`).join('\n') || '  (no migration lines)');
    }
  }
  process.exit(0);
}

// ── plan / apply ──────────────────────────────────────────────────────
const donorMaps = [];
for (const donor of DONORS) {
  const svc = byName.get(donor);
  if (!svc) {
    console.log(`donor ${donor}: not found, skipping`);
    continue;
  }
  const map = await fetchVariables(client, { projectId, environmentId, serviceId: svc.id });
  donorMaps.push([donor, map]);
  console.log(`donor ${donor}: ${Object.keys(map).length} vars readable`);
}

for (const name of TARGETS) {
  const svc = APP_SERVICES.find((s) => s.name === name);
  if (!svc) throw new Error(`${name} not in catalog`);
  const exists = byName.get(name);
  console.log(`\n=== ${name} ${exists ? `(EXISTS: ${exists.id})` : '(missing — will create)'} ===`);

  const { vars, provenance, missing } = buildVarsFromDonors(svc, donorMaps);
  for (const [k, src] of Object.entries(provenance)) console.log(`  ${k}  <- ${src}`);
  if (missing.length) {
    console.log(`  !! UNRESOLVED REQUIRED: ${missing.join(', ')}`);
    if (MODE === 'apply') throw new Error(`Cannot apply: ${name} missing ${missing.join(', ')}`);
  }

  if (MODE !== 'apply') continue;

  const created = await client.createService({
    projectId,
    name,
    source: { repo: githubRepo },
    branch,
  });
  console.log(`  service id: ${created.id}`);

  await client.updateServiceInstance({
    serviceId: created.id,
    environmentId,
    rootDirectory: '.',
    dockerfilePath: svc.dockerfile,
    startCommand: svc.start_command,
    healthcheckPath: svc.healthcheck,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 10,
  });
  console.log('  instance configured (dockerfile, healthcheck, restart policy)');

  await client.upsertVariables({
    projectId,
    environmentId,
    serviceId: created.id,
    variables: vars,
    skipDeploys: true,
  });
  console.log(`  ${Object.keys(vars).length} variables set`);

  await client.triggerDeploy({ projectId, environmentId, serviceId: created.id });
  console.log('  deploy triggered');
}

console.log(`\nMode was "${MODE}". ${MODE === 'plan' ? 'Run with "apply" to provision.' : 'Use "status" to poll deployments.'}`);
