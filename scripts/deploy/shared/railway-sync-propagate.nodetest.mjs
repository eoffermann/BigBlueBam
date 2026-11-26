// node --test scripts/deploy/shared/railway-sync-propagate.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Issue #126: syncNew adds `propagate` env hints that an EXISTING service lacks, never
// overwrites a present value, never touches secrets, prints the planned diff, writes with
// skipDeploys and redeploys each changed service once. No network: the client is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPAGATE_DONE,
  PROPAGATE_PENDING,
  PROPAGATE_PENDING_VAR,
  RailwayOrchestrator,
  buildPropagatedVariables,
  hasPendingPropagateRedeploy,
  planPropagation,
} from './railway-orchestrator.mjs';
import { ENV_HINTS, hintFor, isPropagated } from './env-hints.mjs';
import { APP_SERVICES, INFRA_SERVICES, JOB_SERVICES, getRequiredAppServices, getSelfHostedInfra } from './services.mjs';

const allPlanned = () => [
  ...getRequiredAppServices().filter((s) => s.name !== 'voice-agent'),
  ...getSelfHostedInfra(),
  ...JOB_SERVICES,
];

// Stateful fake: upserts merge into `state`, so a second run can be pointed at what
// the first one stored. failUpsertAt (1-based call number) / failDeployFor (service
// name) make that call throw.
function fakeClient({ liveVars = {}, failUpsertAt = null, failDeployFor = null } = {}) {
  let upsertCount = 0;
  const calls = { upsert: [], deploy: [], getVars: [] };
  const state = {};
  for (const [name, vars] of Object.entries(liveVars)) state[name] = { ...vars };
  const live = allPlanned().map((s, i) => ({ name: s.name, id: `svc-${i}-${s.name}` }));
  const idToName = new Map(live.map((s) => [s.id, s.name]));
  return {
    calls,
    state,
    assertSchemaCompatibility: async () => ({ ok: true, missing: [] }),
    whoami: async () => ({ email: 'ci@example.invalid' }),
    listServices: async () => live,
    getServiceVariables: async ({ serviceId }) => {
      calls.getVars.push(idToName.get(serviceId));
      return { ...(state[idToName.get(serviceId)] ?? {}) };
    },
    upsertVariables: async (args) => {
      const name = idToName.get(args.serviceId);
      upsertCount += 1;
      if (upsertCount === failUpsertAt) throw new Error(`upsert failed for ${name}`);
      calls.upsert.push({ service: name, ...args });
      state[name] = { ...(state[name] ?? {}), ...args.variables };
    },
    triggerDeploy: async ({ serviceId }) => {
      const name = idToName.get(serviceId);
      if (name === failDeployFor) throw new Error(`deploy failed for ${name}`);
      calls.deploy.push(name);
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
  // One write (the missing key + the pending marker), then the marker flip after deploy.
  assert.equal(client.calls.upsert.length, 2);
  const [u, done] = client.calls.upsert;
  assert.equal(u.service, target.name);
  assert.equal(u.skipDeploys, true);
  assert.deepEqual(u.variables, {
    [dropKey]: String(hintFor(dropKey).value),
    [PROPAGATE_PENDING_VAR]: PROPAGATE_PENDING,
  });
  assert.ok(!(keepKey in u.variables));
  assert.equal(done.service, target.name);
  assert.equal(done.skipDeploys, true);
  assert.deepEqual(done.variables, { [PROPAGATE_PENDING_VAR]: PROPAGATE_DONE });
  assert.deepEqual(client.calls.deploy, [target.name]);
  assert.deepEqual(summary.provisioned, []);
});

// ---- issue #137: a failure between a write and its redeploy must not strand it ----

// Two services that both carry propagated vars, in plan order.
const [first, second] = allPlanned().filter((s) => Object.keys(buildPropagatedVariables(s)).length >= 1);
const firstKey = Object.keys(buildPropagatedVariables(first))[0];
const secondKey = Object.keys(buildPropagatedVariables(second))[0];

function strandedVars() {
  const liveVars = inSyncVars();
  delete liveVars[first.name][firstKey];
  delete liveVars[second.name][secondKey];
  return liveVars;
}

test('a throwing second upsert still redeploys the first written service, then rejects', async () => {
  const client = fakeClient({ liveVars: strandedVars(), failUpsertAt: 2 });
  await assert.rejects(
    orchestrator(client, []).syncNew({ projectId: 'proj', environmentId: 'env' }),
    /upsert failed/,
  );
  // Whichever of the two the plan reached first was written, then redeployed anyway.
  const writtenName = client.calls.upsert[0].service;
  const failedName = writtenName === first.name ? second.name : first.name;
  const [wKey, fKey] = writtenName === first.name ? [firstKey, secondKey] : [secondKey, firstKey];
  assert.deepEqual(client.calls.deploy, [writtenName]);
  assert.equal(client.state[writtenName][wKey], String(hintFor(wKey).value));
  assert.equal(client.state[writtenName][PROPAGATE_PENDING_VAR], PROPAGATE_DONE);
  assert.equal(client.state[failedName][fKey], undefined);
});

test('a throwing redeploy leaves the marker pending and the next run redeploys that service', async () => {
  const client = fakeClient({ liveVars: strandedVars(), failDeployFor: first.name });
  await assert.rejects(
    orchestrator(client, []).syncNew({ projectId: 'proj', environmentId: 'env' }),
    /Deploy trigger failed for 1 service\(s\): /,
  );
  // The other written service was still deployed despite the earlier failure.
  assert.ok(client.calls.deploy.includes(second.name));
  assert.equal(client.state[first.name][firstKey], String(hintFor(firstKey).value));
  assert.equal(client.state[first.name][PROPAGATE_PENDING_VAR], PROPAGATE_PENDING);

  // Re-run against the stored state with the fault gone: nothing is "missing", yet
  // the stranded service is redeployed exactly once and its marker cleared.
  const rerun = fakeClient({ liveVars: client.state });
  const summary = await orchestrator(rerun, []).syncNew({ projectId: 'proj', environmentId: 'env' });
  assert.deepEqual(summary.propagated, {});
  assert.deepEqual(summary.resumed, [first.name]);
  assert.deepEqual(rerun.calls.deploy, [first.name]);
  assert.equal(rerun.state[first.name][PROPAGATE_PENDING_VAR], PROPAGATE_DONE);
});

test('a dry run reports a pending marker as a would-redeploy and writes nothing', async () => {
  const liveVars = inSyncVars();
  liveVars[first.name][PROPAGATE_PENDING_VAR] = PROPAGATE_PENDING;
  const client = fakeClient({ liveVars });
  const summary = await orchestrator(client, []).syncNew({ dryRun: true, projectId: 'proj', environmentId: 'env' });
  assert.deepEqual(summary.deployed, [first.name]);
  assert.equal(client.calls.upsert.length, 0);
  assert.equal(client.calls.deploy.length, 0);
});

test('a done marker does not trigger a redeploy', async () => {
  const liveVars = inSyncVars();
  liveVars[first.name][PROPAGATE_PENDING_VAR] = PROPAGATE_DONE;
  const client = fakeClient({ liveVars });
  await orchestrator(client, []).syncNew({ projectId: 'proj', environmentId: 'env' });
  assert.equal(client.calls.deploy.length, 0);
  assert.equal(hasPendingPropagateRedeploy(liveVars[first.name]), false);
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
