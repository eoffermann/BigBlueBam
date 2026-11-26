// node --test scripts/deploy/shared/railway-sync-propagate.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Issue #126: syncNew adds `propagate` env hints that an EXISTING service lacks, never
// overwrites a present value, never touches secrets, prints the planned diff, writes with
// skipDeploys and redeploys each changed service once. No network: the client is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RailwayOrchestrator,
  buildPropagatedVariables,
  planPropagation,
} from './railway-orchestrator.mjs';
import { ENV_HINTS, hintFor, isPropagated } from './env-hints.mjs';
import { APP_SERVICES, INFRA_SERVICES, JOB_SERVICES, getRequiredAppServices, getSelfHostedInfra } from './services.mjs';

const allPlanned = () => [
  ...getRequiredAppServices().filter((s) => s.name !== 'voice-agent'),
  ...getSelfHostedInfra(),
  ...JOB_SERVICES,
];

function fakeClient({ liveVars = {} } = {}) {
  const calls = { upsert: [], deploy: [], getVars: [] };
  const live = allPlanned().map((s, i) => ({ name: s.name, id: `svc-${i}-${s.name}` }));
  const idToName = new Map(live.map((s) => [s.id, s.name]));
  return {
    calls,
    assertSchemaCompatibility: async () => ({ ok: true, missing: [] }),
    whoami: async () => ({ email: 'ci@example.invalid' }),
    listServices: async () => live,
    getServiceVariables: async ({ serviceId }) => {
      calls.getVars.push(idToName.get(serviceId));
      return { ...(liveVars[idToName.get(serviceId)] ?? {}) };
    },
    upsertVariables: async (args) => {
      calls.upsert.push({ service: idToName.get(args.serviceId), ...args });
    },
    triggerDeploy: async ({ serviceId }) => {
      calls.deploy.push(idToName.get(serviceId));
    },
    createService: async () => {
      throw new Error('must not create services in this test');
    },
  };
}

function orchestrator(client, events) {
  return new RailwayOrchestrator(client, {
    projectName: 'p',
    githubRepo: 'o/r',
    branch: 'stable',
    onProgress: (ev) => events.push(ev),
  });
}

/** Live vars for every service = its full propagated set (i.e. fully in sync). */
function inSyncVars() {
  const out = {};
  for (const s of allPlanned()) out[s.name] = buildPropagatedVariables(s);
  return out;
}

// A service whose catalog lists at least one propagated var, to drop it and watch it return.
const target = allPlanned().find((s) => Object.keys(buildPropagatedVariables(s)).length >= 2);
const [dropKey, keepKey] = Object.keys(buildPropagatedVariables(target));

test('every *_API_INTERNAL_URL / *_API_URL computed hint propagates; no secret does', () => {
  for (const [name, h] of Object.entries(ENV_HINTS)) {
    if (h.kind === 'computed' && /_API_(INTERNAL_)?URL$/.test(name)) assert.ok(isPropagated(name), name);
    if (h.kind === 'secret') assert.equal(isPropagated(name), false, name);
  }
  assert.ok(isPropagated('BOLT_API_INTERNAL_URL'));
  assert.equal(isPropagated('SESSION_SECRET'), false);
});

test('planPropagation adds only absent keys and never overwrites, even empty values', () => {
  const desired = { A_API_URL: 'http://a', B_API_URL: 'http://b', C_API_URL: 'http://c' };
  const live = { A_API_URL: 'http://custom', B_API_URL: '' };
  assert.deepEqual(planPropagation(desired, live), { C_API_URL: 'http://c' });
});

test('dry run: prints the planned additions, writes nothing, deploys nothing', async () => {
  const liveVars = inSyncVars();
  delete liveVars[target.name][dropKey];
  const client = fakeClient({ liveVars });
  const events = [];
  const summary = await orchestrator(client, events).syncNew({
    dryRun: true,
    projectId: 'proj',
    environmentId: 'env',
  });
  assert.deepEqual(summary.propagated, { [target.name]: { [dropKey]: String(hintFor(dropKey).value) } });
  assert.equal(client.calls.upsert.length, 0);
  assert.equal(client.calls.deploy.length, 0);
  assert.deepEqual(summary.deployed, [target.name]);
  const lines = events.filter((e) => e.phase === 'sync-vars').map((e) => e.message);
  assert.deepEqual(lines, [`would add ${target.name}: ${dropKey}=${hintFor(dropKey).value}`]);
});

test('apply: upserts only the missing key with skipDeploys, then one redeploy for that service', async () => {
  const liveVars = inSyncVars();
  delete liveVars[target.name][dropKey];
  liveVars[target.name][keepKey] = 'http://operator-override'; // present: must survive
  const client = fakeClient({ liveVars });
  const summary = await orchestrator(client, []).syncNew({ projectId: 'proj', environmentId: 'env' });
  assert.equal(client.calls.upsert.length, 1);
  const [u] = client.calls.upsert;
  assert.equal(u.service, target.name);
  assert.equal(u.skipDeploys, true);
  assert.deepEqual(u.variables, { [dropKey]: String(hintFor(dropKey).value) });
  assert.ok(!(keepKey in u.variables));
  assert.deepEqual(client.calls.deploy, [target.name]);
  assert.deepEqual(summary.provisioned, []);
});

test('a fully in-sync project produces no writes and no deploys', async () => {
  const client = fakeClient({ liveVars: inSyncVars() });
  const summary = await orchestrator(client, []).syncNew({ projectId: 'proj', environmentId: 'env' });
  assert.deepEqual(summary.propagated, {});
  assert.equal(client.calls.upsert.length, 0);
  assert.equal(client.calls.deploy.length, 0);
});

test('only propagate hints are ever planned (no secrets, no plugin refs)', () => {
  for (const s of [...APP_SERVICES, ...INFRA_SERVICES, ...JOB_SERVICES]) {
    for (const k of Object.keys(buildPropagatedVariables(s))) {
      assert.ok(['computed', 'literal'].includes(hintFor(k).kind), `${s.name}:${k}`);
    }
  }
});
