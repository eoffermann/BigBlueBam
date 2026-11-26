// node --test scripts/deploy/shared/railway-secrets.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Issue #139: when the live service holding a stable secret cannot be read, the CI
// reconcile must fail closed rather than mint a divergent value for a new consumer.
// No network: the Railway client is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StableSecretUnreadableError,
  collectSharedSecrets,
  fillMissingSecrets,
} from './railway-secrets.mjs';

const STABLE = 'X_SEAL_SIGNING_KEY';
// A fake catalog: the holder already runs; the consumer is being provisioned.
const holder = { name: 'x-api', env: { required: [STABLE], optional: [] } };
const consumer = { name: 'x-worker', env: { required: [STABLE], optional: [] } };
const services = [holder, consumer];
const stableNames = [STABLE];

function fakeClient({ vars = {}, throwFor = new Set() } = {}) {
  const reads = [];
  return {
    reads,
    getServiceVariables: async ({ serviceId }) => {
      reads.push(serviceId);
      if (throwFor.has(serviceId)) throw new Error('Railway GraphQL 503');
      return { ...(vars[serviceId] ?? {}) };
    },
  };
}

const liveByName = new Map([[holder.name, 'id-holder']]);
let n = 0;
const generate = () => `gen-${++n}`;

test('a failed read of the stable-secret holder aborts: nothing is generated', async () => {
  const client = fakeClient({ vars: { 'id-holder': { [STABLE]: 'canonical' } }, throwFor: new Set(['id-holder']) });
  const logs = [];
  const { collected, readFailures } = await collectSharedSecrets(client, {
    projectId: 'p',
    environmentId: 'e',
    liveByName,
    log: (m) => logs.push(m),
    services,
    stableNames,
  });
  assert.ok(client.reads.includes('id-holder'));
  assert.equal(collected[STABLE], undefined);
  assert.match(readFailures[holder.name], /503/);

  let thrown;
  try {
    fillMissingSecrets(collected, [consumer], { readFailures, liveByName, services, stableNames, generate });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof StableSecretUnreadableError);
  assert.equal(thrown.code, 'SECRET_UNREADABLE');
  assert.match(thrown.message, new RegExp(STABLE));
  assert.match(thrown.message, /x-api/);
  assert.equal(collected[STABLE], undefined, 'no value may be minted');
});

test('a readable holder with the value: the value is copied forward, never regenerated', async () => {
  const client = fakeClient({ vars: { 'id-holder': { [STABLE]: 'canonical' } } });
  const { collected, readFailures } = await collectSharedSecrets(client, {
    projectId: 'p',
    environmentId: 'e',
    liveByName,
    services,
    stableNames,
  });
  const gen = fillMissingSecrets(collected, [consumer], { readFailures, liveByName, services, stableNames, generate });
  assert.deepEqual(gen, []);
  assert.equal(collected[STABLE], 'canonical');
});

test('no live holder at all (first provisioning): the stable secret is generated once', async () => {
  const empty = new Map();
  const client = fakeClient();
  const { collected, readFailures } = await collectSharedSecrets(client, {
    projectId: 'p',
    environmentId: 'e',
    liveByName: empty,
    services,
    stableNames,
  });
  const gen = fillMissingSecrets(collected, [holder, consumer], {
    readFailures,
    liveByName: empty,
    services,
    stableNames,
    generate,
  });
  assert.deepEqual(gen, [`${STABLE} (for x-api)`]);
  assert.match(collected[STABLE], /^gen-/);
});

test('a failed read of an unrelated service does not block a stable secret it does not hold', async () => {
  const other = { name: 'y-api', env: { required: [], optional: [] } };
  const live = new Map([
    [holder.name, 'id-holder'],
    ['api', 'id-api'],
  ]);
  const client = fakeClient({ vars: { 'id-holder': { [STABLE]: 'canonical' } }, throwFor: new Set(['id-api']) });
  const { collected, readFailures } = await collectSharedSecrets(client, {
    projectId: 'p',
    environmentId: 'e',
    liveByName: live,
    services: [...services, other],
    stableNames,
  });
  assert.ok('api' in readFailures);
  fillMissingSecrets(collected, [consumer], { readFailures, liveByName: live, services, stableNames, generate });
  assert.equal(collected[STABLE], 'canonical');
});

// ── Issue #154: ordinary shared secrets fail closed too ────────────────────────
// SESSION_SECRET and INTERNAL_SERVICE_SECRET are `secret`-kind in env-hints and are
// shared by every app; neither is a stable secret.
const SHARED = ['SESSION_SECRET', 'INTERNAL_SERVICE_SECRET'];
const sApi = { name: 'api', env: { required: SHARED, optional: [] } };
const sPeer = { name: 'peer-api', env: { required: SHARED, optional: [] } };
const sNew = { name: 'new-api', env: { required: SHARED, optional: [] } };
const sServices = [sApi, sPeer, sNew];

async function collectShared(client, live) {
  return collectSharedSecrets(client, {
    projectId: 'p',
    environmentId: 'e',
    liveByName: live,
    services: sServices,
    stableNames: [],
  });
}

test('#154: api unreadable and no other holder answers: SESSION_SECRET is not minted, the run stops', async () => {
  const live = new Map([['api', 'id-api']]);
  const client = fakeClient({ throwFor: new Set(['id-api']) });
  const { collected, readFailures } = await collectShared(client, live);
  let thrown;
  try {
    fillMissingSecrets(collected, [sNew], { readFailures, liveByName: live, services: sServices, stableNames: [], generate });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'must throw instead of generating');
  assert.equal(thrown.code, 'SECRET_UNREADABLE');
  assert.match(thrown.message, /SESSION_SECRET \(needed by new-api\) is held by api/);
  assert.match(thrown.message, /INTERNAL_SERVICE_SECRET/);
  assert.equal(collected.SESSION_SECRET, undefined);
  assert.equal(collected.INTERNAL_SERVICE_SECRET, undefined);
});

test('#154: api unreadable but another live holder has the values: they are copied, nothing generated', async () => {
  const live = new Map([
    ['api', 'id-api'],
    ['peer-api', 'id-peer'],
  ]);
  const client = fakeClient({
    vars: { 'id-peer': { SESSION_SECRET: 'sess-live', INTERNAL_SERVICE_SECRET: 'int-live' } },
    throwFor: new Set(['id-api']),
  });
  const { collected, readFailures } = await collectShared(client, live);
  assert.ok(client.reads.includes('id-peer'), 'falls back to reading the other live holder');
  const gen = fillMissingSecrets(collected, [sNew], {
    readFailures,
    liveByName: live,
    services: sServices,
    stableNames: [],
    generate,
  });
  assert.deepEqual(gen, []);
  assert.equal(collected.SESSION_SECRET, 'sess-live');
  assert.equal(collected.INTERNAL_SERVICE_SECRET, 'int-live');
});

test('#154: the copied value wins over generation even when the preferred source lacks it', async () => {
  const live = new Map([
    ['api', 'id-api'],
    ['peer-api', 'id-peer'],
  ]);
  const client = fakeClient({ vars: { 'id-api': {}, 'id-peer': { SESSION_SECRET: 'sess-peer', INTERNAL_SERVICE_SECRET: 'int-peer' } } });
  const { collected, readFailures } = await collectShared(client, live);
  fillMissingSecrets(collected, [sNew], { readFailures, liveByName: live, services: sServices, stableNames: [], generate });
  assert.equal(collected.SESSION_SECRET, 'sess-peer');
});

test('#154: every live holder read and none holds it: generation is allowed', async () => {
  const live = new Map([['api', 'id-api']]);
  const client = fakeClient({ vars: { 'id-api': {} } });
  const { collected, readFailures } = await collectShared(client, live);
  const gen = fillMissingSecrets(collected, [sNew], {
    readFailures,
    liveByName: live,
    services: sServices,
    stableNames: [],
    generate,
  });
  assert.deepEqual(gen.sort(), ['INTERNAL_SERVICE_SECRET (for new-api)', 'SESSION_SECRET (for new-api)']);
});

test('#154: first provisioning (nothing live) still generates the shared secrets once', async () => {
  const live = new Map();
  const { collected, readFailures } = await collectShared(fakeClient(), live);
  const gen = fillMissingSecrets(collected, [sApi, sNew], {
    readFailures,
    liveByName: live,
    services: sServices,
    stableNames: [],
    generate,
  });
  assert.deepEqual(gen.sort(), ['INTERNAL_SERVICE_SECRET (for api)', 'SESSION_SECRET (for api)']);
});
