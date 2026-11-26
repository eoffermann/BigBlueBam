// node --test scripts/deploy/shared/secrets-stable.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// The stable-secret class in generateSecrets(): generated only when no live value exists,
// never rehydrated from '[REDACTED]' saved state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REDACTED,
  buildEnvConfig,
  generateSecrets,
  parseEnvText,
  resolveStableSecrets,
  stableSecretNames,
} from './secrets.mjs';
import { sanitizeState } from './state.mjs';

const NAMES = ['X_SEAL_SIGNING_KEY', 'X_FEED_KEY_PEPPER'];
let n = 0;
const gen = () => `gen-${++n}`;

test('no live and no saved value: generated', () => {
  const r = resolveStableSecrets({ names: NAMES, generate: gen });
  assert.deepEqual(r.generated, NAMES);
  assert.deepEqual(r.unresolved, []);
  assert.ok(r.values.X_SEAL_SIGNING_KEY.startsWith('gen-'));
});

test('a live value is reused, never regenerated', () => {
  const r = resolveStableSecrets({ names: NAMES, live: { X_SEAL_SIGNING_KEY: 'live-a', X_FEED_KEY_PEPPER: 'live-b' }, generate: gen });
  assert.deepEqual(r.values, { X_SEAL_SIGNING_KEY: 'live-a', X_FEED_KEY_PEPPER: 'live-b' });
  assert.deepEqual(r.generated, []);
});

test('[REDACTED] saved state with no live value is unresolved, NOT regenerated', () => {
  const r = resolveStableSecrets({ names: NAMES, saved: { X_SEAL_SIGNING_KEY: REDACTED }, generate: gen });
  assert.deepEqual(r.unresolved, ['X_SEAL_SIGNING_KEY']);
  assert.ok(!('X_SEAL_SIGNING_KEY' in r.values));
  assert.deepEqual(r.generated, ['X_FEED_KEY_PEPPER']);
});

test('[REDACTED] saved state with a live value reuses the live value', () => {
  const r = resolveStableSecrets({
    names: NAMES,
    live: { X_SEAL_SIGNING_KEY: 'live-a' },
    saved: { X_SEAL_SIGNING_KEY: REDACTED, X_FEED_KEY_PEPPER: REDACTED },
    generate: gen,
  });
  assert.deepEqual(r.values, { X_SEAL_SIGNING_KEY: 'live-a' });
  assert.deepEqual(r.unresolved, ['X_FEED_KEY_PEPPER']);
});

test('an empty live value counts as absent', () => {
  const r = resolveStableSecrets({ names: ['X_SEAL_SIGNING_KEY'], live: { X_SEAL_SIGNING_KEY: '' }, generate: gen });
  assert.deepEqual(r.generated, ['X_SEAL_SIGNING_KEY']);
});

test('generateSecrets: re-rollable set unchanged, stable values merged, unresolved omitted', () => {
  const s = generateSecrets({
    stableNames: NAMES,
    live: { X_SEAL_SIGNING_KEY: 'live-a' },
    saved: { X_FEED_KEY_PEPPER: REDACTED },
  });
  assert.equal(s.X_SEAL_SIGNING_KEY, 'live-a');
  assert.ok(!('X_FEED_KEY_PEPPER' in s));
  assert.equal(s.SESSION_SECRET.length, 64);
  assert.equal(s.MINIO_ROOT_USER, 'bigbluebam');
  // Default call stays backward compatible.
  assert.equal(typeof generateSecrets().SESSION_SECRET, 'string');
});

test('the main.mjs rehydrate loop cannot regenerate a redacted stable secret', () => {
  // Mirrors scripts/deploy/main.mjs: fresh = generateSecrets({live, saved}); then any key
  // that is missing or '[REDACTED]' in envConfig is filled from `fresh`.
  const envConfig = { SESSION_SECRET: REDACTED, X_SEAL_SIGNING_KEY: REDACTED };
  const fresh = generateSecrets({ stableNames: NAMES, live: {}, saved: envConfig });
  for (const [key, value] of Object.entries(fresh)) {
    if (!envConfig[key] || envConfig[key] === REDACTED) envConfig[key] = value;
  }
  assert.equal(envConfig.X_SEAL_SIGNING_KEY, REDACTED); // untouched, reported instead
  assert.notEqual(envConfig.SESSION_SECRET, REDACTED); // re-rollable: rehydrated as before
});

test('stableSecretNames reads `kind: secret, stable: true` hints only', () => {
  const hints = {
    A_KEY: { kind: 'secret', stable: true },
    B_KEY: { kind: 'secret' },
    C_URL: { kind: 'computed', value: 'x' },
  };
  assert.deepEqual(stableSecretNames(hints), ['A_KEY']);
  assert.ok(Array.isArray(stableSecretNames()));
});

test('parseEnvText reads KEY=VALUE lines', () => {
  assert.deepEqual(parseEnvText('# c\nA=1\r\nB=\n bad=2\n'), { A: '1', B: '' });
});

test('buildEnvConfig still builds without stable secrets', () => {
  const env = buildEnvConfig({
    secrets: generateSecrets(),
    storage: { storageProvider: 'skip' },
    vectorDb: { vectorProvider: 'skip' },
    livekit: { livekitProvider: 'skip' },
    integrations: {},
    domain: 'localhost',
  });
  assert.equal(env.DOMAIN, 'localhost');
});

test('state redaction covers salt and pepper secrets', () => {
  const clean = sanitizeState({ envConfig: { BASTION_ROOM_IP_SALT: 'a', BASTION_FEED_KEY_PEPPER: 'b', DOMAIN: 'x' } });
  assert.equal(clean.envConfig.BASTION_ROOM_IP_SALT, REDACTED);
  assert.equal(clean.envConfig.BASTION_FEED_KEY_PEPPER, REDACTED);
  assert.equal(clean.envConfig.DOMAIN, 'x');
});
