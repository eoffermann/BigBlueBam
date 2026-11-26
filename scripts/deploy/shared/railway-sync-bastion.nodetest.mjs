// node --test scripts/deploy/shared/railway-sync-bastion.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Bastion M1 gate (spec 9.4 / 12): on a Railway project that predates Bastion, a syncNew dry
// run plans BASTION_S3_BUCKET and BASTION_API_INTERNAL_URL onto the EXISTING worker (plus the
// URL onto bolt-api and BASTION_API_URL onto mcp-server), never a Bastion secret, and writes
// nothing. No network and no Railway token: the client is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RailwayOrchestrator, buildPropagatedVariables } from './railway-orchestrator.mjs';
import { hintFor, isPropagated } from './env-hints.mjs';
import { APP_SERVICES, JOB_SERVICES, getRequiredAppServices, getSelfHostedInfra } from './services.mjs';

const BASTION_PROPAGATED = ['BASTION_API_INTERNAL_URL', 'BASTION_API_URL', 'BASTION_S3_BUCKET'];
const BASTION_SECRETS = [
  'BASTION_SEAL_SIGNING_KEY',
  'BASTION_PD_HMAC_KEY',
  'BASTION_ROOM_IP_SALT',
  'BASTION_FEED_KEY_PEPPER',
  'BASTION_BACKUP_S3_ACCESS_KEY',
  'BASTION_BACKUP_S3_SECRET_KEY',
];

const allPlanned = () => [
  ...getRequiredAppServices().filter((s) => s.name !== 'voice-agent'),
  ...getSelfHostedInfra(),
  ...JOB_SERVICES,
];

/** A project that is fully in sync EXCEPT that nothing Bastion has reached it yet. */
function preBastionVars() {
  const out = {};
  for (const s of allPlanned()) {
    const vars = buildPropagatedVariables(s);
    for (const k of Object.keys(vars)) if (k.startsWith('BASTION_')) delete vars[k];
    out[s.name] = vars;
  }
  return out;
}

function fakeClient(liveVars) {
  const calls = { upsert: [], deploy: [] };
  const live = allPlanned().map((s, i) => ({ name: s.name, id: `svc-${i}-${s.name}` }));
  const idToName = new Map(live.map((s) => [s.id, s.name]));
  return {
    calls,
    assertSchemaCompatibility: async () => ({ ok: true, missing: [] }),
    whoami: async () => ({ email: 'ci@example.invalid' }),
    listServices: async () => live,
    getServiceVariables: async ({ serviceId }) => ({ ...(liveVars[idToName.get(serviceId)] ?? {}) }),
    upsertVariables: async (args) => calls.upsert.push(args),
    triggerDeploy: async ({ serviceId }) => calls.deploy.push(idToName.get(serviceId)),
    createService: async () => {
      throw new Error('must not create services in this test');
    },
  };
}

test('the Bastion URL and bucket hints propagate; no Bastion secret does', () => {
  for (const name of BASTION_PROPAGATED) assert.equal(isPropagated(name), true, name);
  for (const name of BASTION_SECRETS) assert.equal(isPropagated(name), false, name);
});

test('the worker catalog entry carries the bucket and URL but no Bastion secret', () => {
  const worker = APP_SERVICES.find((s) => s.name === 'worker');
  const vars = [...worker.env.required, ...worker.env.optional];
  assert.ok(vars.includes('BASTION_S3_BUCKET'));
  assert.ok(vars.includes('BASTION_API_INTERNAL_URL'));
  for (const name of BASTION_SECRETS) assert.ok(!vars.includes(name), name);
});

test('dry run against a pre-Bastion project adds the bucket and URL to the existing worker', async () => {
  const client = fakeClient(preBastionVars());
  const events = [];
  const summary = await new RailwayOrchestrator(client, {
    projectName: 'p',
    githubRepo: 'o/r',
    branch: 'stable',
    onProgress: (ev) => events.push(ev),
  }).syncNew({ dryRun: true, projectId: 'proj', environmentId: 'env' });

  assert.deepEqual(summary.propagated.worker, {
    BASTION_API_INTERNAL_URL: String(hintFor('BASTION_API_INTERNAL_URL').value),
    BASTION_S3_BUCKET: 'bigbluebam-bastion',
  });
  assert.match(summary.propagated.worker.BASTION_API_INTERNAL_URL, /^http:\/\/bastion-api\.railway\.internal:8080$/);
  assert.deepEqual(summary.propagated['bolt-api'], {
    BASTION_API_INTERNAL_URL: String(hintFor('BASTION_API_INTERNAL_URL').value),
  });
  assert.deepEqual(summary.propagated['mcp-server'], {
    BASTION_API_URL: String(hintFor('BASTION_API_URL').value),
  });
  // No secret is ever planned onto any service.
  for (const vars of Object.values(summary.propagated)) {
    for (const name of BASTION_SECRETS) assert.ok(!(name in vars), name);
  }
  // Dry run: nothing written, nothing deployed, and the plan is printed.
  assert.equal(client.calls.upsert.length, 0);
  assert.equal(client.calls.deploy.length, 0);
  const lines = events.filter((e) => e.phase === 'sync-vars').map((e) => e.message);
  assert.ok(lines.includes('would add worker: BASTION_S3_BUCKET=bigbluebam-bastion'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('would add worker: BASTION_API_INTERNAL_URL=')));
});

test('an operator-set bucket name on the worker is never overwritten', async () => {
  const liveVars = preBastionVars();
  liveVars.worker.BASTION_S3_BUCKET = 'acme-compliance-evidence';
  const summary = await new RailwayOrchestrator(fakeClient(liveVars), {
    projectName: 'p',
    githubRepo: 'o/r',
    branch: 'stable',
    onProgress: () => {},
  }).syncNew({ dryRun: true, projectId: 'proj', environmentId: 'env' });
  assert.ok(!('BASTION_S3_BUCKET' in summary.propagated.worker));
  assert.ok('BASTION_API_INTERNAL_URL' in summary.propagated.worker);
});
