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
  assert.equal(thrown.code, 'STABLE_SECRET_UNREADABLE');
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
