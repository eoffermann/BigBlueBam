// node --test scripts/deploy/shared/storage-prompt-bastion.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// Issue #171 (Bastion spec 9.1): on AWS S3 and Cloudflare R2 the storage prompt asks for
// the Bastion evidence bucket, defaulting to `<S3_BUCKET>-bastion`, because bucket names
// are global there. MinIO (and skip) keep the literal `bigbluebam-bastion`. The chosen
// value must reach the place it is consumed: .env for docker-compose, and the Railway
// variable bundle (first provision and the propagate pass) instead of the hint literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BASTION_BUCKET,
  buildEnvConfig,
  generateSecrets,
  promptStorageChoice,
  suggestedBastionBucket,
} from './secrets.mjs';
import { buildAuthoritativeVariables, buildPropagatedVariables, buildServiceVariables } from './railway-orchestrator.mjs';
import { hintFor } from './env-hints.mjs';
import { APP_SERVICES } from './services.mjs';

/** A fake prompt: picks `provider`, answers from `answers` by question, else accepts the default. */
function fakeIo(provider, answers = {}) {
  const asked = [];
  const answer = async (question, defaultValue) => {
    asked.push({ question, defaultValue });
    const key = Object.keys(answers).find((k) => question.startsWith(k));
    return key ? answers[key] : (defaultValue ?? 'x');
  };
  return { asked, io: { select: async () => provider, ask: answer, askPassword: answer } };
}

const bastionQuestion = (asked) => asked.find((a) => a.question.startsWith('Bastion evidence bucket'));

for (const provider of ['s3', 'r2']) {
  test(`${provider}: asks for the Bastion bucket, defaulting to <S3_BUCKET>-bastion`, async () => {
    const { asked, io } = fakeIo(provider, { 'Bucket name:': 'acme-files' });
    const config = await promptStorageChoice(io);
    assert.equal(bastionQuestion(asked)?.defaultValue, 'acme-files-bastion');
    assert.equal(config.BASTION_S3_BUCKET, 'acme-files-bastion');
  });

  test(`${provider}: accepting the default uploads bucket suggests bigbluebam-uploads-bastion`, async () => {
    const { asked, io } = fakeIo(provider);
    await promptStorageChoice(io);
    assert.equal(bastionQuestion(asked)?.defaultValue, 'bigbluebam-uploads-bastion');
  });
}

for (const provider of ['minio', 'skip']) {
  test(`${provider}: never asks, and keeps the literal default`, async () => {
    const { asked, io } = fakeIo(provider);
    const config = await promptStorageChoice(io);
    assert.equal(bastionQuestion(asked), undefined);
    assert.equal(config.BASTION_S3_BUCKET, undefined);
    assert.equal(hintFor('BASTION_S3_BUCKET').value, DEFAULT_BASTION_BUCKET);
  });
}

test('suggestedBastionBucket falls back to the literal for an empty uploads bucket', () => {
  assert.equal(suggestedBastionBucket(''), DEFAULT_BASTION_BUCKET);
  assert.equal(suggestedBastionBucket(' team-uploads '), 'team-uploads-bastion');
});

const envFor = (storage) =>
  buildEnvConfig({
    secrets: generateSecrets(),
    storage,
    vectorDb: { vectorProvider: 'skip' },
    livekit: { livekitProvider: 'skip' },
    integrations: {},
    domain: 'localhost',
  });

test('buildEnvConfig carries the chosen bucket for S3/R2 and leaves MinIO to the compose default', () => {
  const s3 = envFor({
    storageProvider: 's3',
    S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 'b',
    S3_BUCKET: 'acme-files',
    S3_REGION: 'us-east-1',
    BASTION_S3_BUCKET: 'acme-evidence',
  });
  assert.equal(s3.BASTION_S3_BUCKET, 'acme-evidence');
  // A state saved before #171 (no prompted value) still gets the derived suggestion.
  const resumed = envFor({ storageProvider: 'r2', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b', S3_BUCKET: 'acme-files', S3_REGION: 'auto' });
  assert.equal(resumed.BASTION_S3_BUCKET, 'acme-files-bastion');
  assert.equal(envFor({ storageProvider: 'minio' }).BASTION_S3_BUCKET, undefined);
});

test('Railway: the chosen bucket wins over the hint literal on first provision and propagation', () => {
  const bastion = APP_SERVICES.find((s) => s.name === 'bastion-api');
  const worker = APP_SERVICES.find((s) => s.name === 'worker');
  const chosen = { BASTION_S3_BUCKET: 'acme-evidence' };
  // Propagate pass onto an existing worker.
  assert.equal(buildPropagatedVariables(worker, chosen).BASTION_S3_BUCKET, 'acme-evidence');
  assert.equal(buildPropagatedVariables(worker).BASTION_S3_BUCKET, DEFAULT_BASTION_BUCKET);
  // First provision of bastion-api (all secrets supplied so required vars resolve).
  const secrets = new Proxy({}, { get: () => 'x'.repeat(64) });
  const vars = buildServiceVariables(bastion, { generatedSecrets: secrets, userIntegrations: chosen });
  assert.equal(vars.BASTION_S3_BUCKET, 'acme-evidence');
  // Reconcile never resets an operator-chosen bucket to the literal.
  assert.equal('BASTION_S3_BUCKET' in buildAuthoritativeVariables(worker), false);
  assert.equal('BASTION_S3_BUCKET' in buildAuthoritativeVariables(bastion), false);
});
