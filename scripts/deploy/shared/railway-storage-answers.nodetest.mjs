// node --test scripts/deploy/shared/railway-storage-answers.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Issue #175: the interactive deploy asks for AWS S3 / Cloudflare R2 settings, but on
// Railway those answers never reached any service; the MinIO defaults were planned
// instead. Checked where the values are consumed: the variables the orchestrator plans
// for every service that reads S3_*, built from the adapter's real envConfig handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvConfig, generateSecrets, operatorStorageValues } from './secrets.mjs';
import { buildAuthoritativeVariables, buildServiceVariables } from './railway-orchestrator.mjs';
import { hintFor, operatorChosenVarNames } from './env-hints.mjs';
import { APP_SERVICES } from './services.mjs';
import { extractUserIntegrationsFromEnvConfig } from '../platforms/railway.mjs';

const S3_VARS = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'S3_REGION'];
const secrets = new Proxy({}, { get: () => 'x'.repeat(64) });

const envFor = (storage) =>
  buildEnvConfig({
    secrets: generateSecrets(),
    storage,
    vectorDb: { vectorProvider: 'skip' },
    livekit: { livekitProvider: 'skip' },
    integrations: {},
    domain: 'localhost',
  });

/** Variables the orchestrator plans for `service` from this envConfig, the way railway.mjs hands it over. */
const planned = (service, envConfig) =>
  buildServiceVariables(service, {
    generatedSecrets: secrets,
    publicUrl: 'https://skipper.example',
    userIntegrations: extractUserIntegrationsFromEnvConfig(envConfig),
  });

const s3Consumers = APP_SERVICES.filter((s) =>
  [...(s.env?.required ?? []), ...(s.env?.optional ?? [])].includes('S3_ENDPOINT'),
);

test('every S3_* variable is operator-chosen', () => {
  for (const v of [...S3_VARS, 'BASTION_S3_BUCKET']) assert.ok(operatorChosenVarNames().includes(v), v);
});

test('R2: the answers reach every service that reads S3_*', () => {
  const env = envFor({
    storageProvider: 'r2',
    S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    S3_ACCESS_KEY: 'r2-key',
    S3_SECRET_KEY: 'r2-secret',
    S3_BUCKET: 'skipper-files',
    S3_REGION: 'auto',
    BASTION_S3_BUCKET: 'skipper-evidence',
  });
  assert.ok(s3Consumers.length >= 10, `expected the S3 consumers, got ${s3Consumers.map((s) => s.name)}`);
  for (const svc of s3Consumers) {
    const vars = planned(svc, env);
    assert.equal(vars.S3_ENDPOINT, 'https://acct.r2.cloudflarestorage.com', svc.name);
    assert.equal(vars.S3_ACCESS_KEY, 'r2-key', svc.name);
    assert.equal(vars.S3_SECRET_KEY, 'r2-secret', svc.name);
    assert.equal(vars.S3_BUCKET, 'skipper-files', svc.name);
    assert.equal(vars.S3_REGION, 'auto', svc.name);
  }
  const worker = APP_SERVICES.find((s) => s.name === 'worker');
  assert.equal(planned(worker, env).BASTION_S3_BUCKET, 'skipper-evidence');
});

test('AWS with a blank endpoint plans the regional AWS endpoint, not the MinIO host', () => {
  const env = envFor({
    storageProvider: 's3',
    S3_ENDPOINT: '',
    S3_ACCESS_KEY: 'aws-key',
    S3_SECRET_KEY: 'aws-secret',
    S3_BUCKET: 'howell-files',
    S3_REGION: 'eu-west-1',
  });
  const api = APP_SERVICES.find((s) => s.name === 'api');
  const vars = planned(api, env);
  assert.equal(vars.S3_ENDPOINT, 'https://s3.eu-west-1.amazonaws.com');
  assert.equal(vars.S3_REGION, 'eu-west-1');
  assert.equal(vars.S3_BUCKET, 'howell-files');
  // docker-compose's .env gets the same endpoint.
  assert.equal(env.S3_ENDPOINT, 'https://s3.eu-west-1.amazonaws.com');
});

test('MinIO keeps the Railway MinIO defaults (never the compose http://minio:9000 host)', () => {
  const env = envFor({ storageProvider: 'minio' });
  assert.equal(env.S3_ENDPOINT, 'http://minio:9000'); // the compose .env value
  assert.deepEqual(operatorStorageValues({ storageProvider: 'minio' }), {});
  const api = APP_SERVICES.find((s) => s.name === 'api');
  const vars = planned(api, env);
  for (const v of S3_VARS) assert.equal(vars[v], hintFor(v).value, v);
});

test('a state saved before #175 (no OPERATOR_CHOICES) still carries the Bastion bucket answer', () => {
  const legacy = { BASTION_S3_BUCKET: 'acme-evidence', S3_ENDPOINT: 'http://minio:9000' };
  const ui = extractUserIntegrationsFromEnvConfig(legacy);
  assert.equal(ui.BASTION_S3_BUCKET, 'acme-evidence');
  assert.equal(ui.S3_ENDPOINT, undefined);
});

test('reconcile never resets an operator-chosen storage value to the MinIO default', () => {
  for (const svc of s3Consumers) {
    const auth = buildAuthoritativeVariables(svc);
    for (const v of S3_VARS) assert.equal(v in auth, false, `${svc.name} ${v}`);
  }
});

test('OPERATOR_CHOICES is deploy metadata: the compose .env writer skips it', async () => {
  const env = envFor({ storageProvider: 'r2', S3_ENDPOINT: 'https://e', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' });
  assert.equal(typeof env.OPERATOR_CHOICES, 'object');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../platforms/docker-compose.mjs', import.meta.url), 'utf8');
  assert.match(src, /typeof val === 'object'\) continue/);
});
