import { parseProviderConfig, type ProviderSecret } from './config.js';
import type { StorageDriver, StorageDriverKind } from './driver.js';
import { S3Driver } from './s3-driver.js';
import { StorageNotConfiguredError } from './errors.js';

export interface ProviderRow {
  kind: StorageDriverKind;
  config: unknown;
}

/**
 * Resolve a storage_providers row + its decrypted secret to a ready driver
 * (Bin master §4). s3/local are MinIO-backed; rclone is a backup-only path
 * invoked by the worker, never constructed for the hot request path.
 */
export function createDriver(provider: ProviderRow, secret: ProviderSecret): StorageDriver {
  const parsed = parseProviderConfig(provider.kind, provider.config);
  switch (parsed.kind) {
    case 's3':
    case 'local':
      return new S3Driver({
        kind: parsed.kind,
        endpoint: parsed.config.endpoint,
        region: parsed.config.region,
        bucket: parsed.config.bucket,
        basePath: parsed.config.basePath,
        accessKey: secret.accessKey,
        secretKey: secret.secretKey,
      });
    case 'rclone':
      throw new Error(
        'rclone is a backup-only driver and is invoked via the worker, not the hot request path',
      );
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`unsupported provider: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ─── Env-driven bootstrap driver, shared by every service (issue #164) ───
//
// banter-api, bill-api, the worker's bill-pdf job, bin-api, blip-api, bay-api and
// bastion-api each used to hand-roll this: a lazy createBootstrapDriver singleton
// over their S3_* env, with their own idea of when storage counts as "not
// configured", their own defaults and their own error vocabulary. Each now passes
// its own validated env module here, so there is one rule and one vocabulary.

/** The S3_* settings a service's validated env module provides. */
export interface StorageEnv {
  S3_ENDPOINT?: string | null;
  S3_ACCESS_KEY?: string | null;
  S3_SECRET_KEY?: string | null;
  S3_REGION: string;
  S3_BUCKET: string;
}

/**
 * The one "is storage configured" rule: an endpoint, both credentials and a
 * bucket are all present. There are no default credentials in this package; a
 * service that wants defaults declares them in its own env schema.
 */
export function isStorageConfigured(env: StorageEnv): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.S3_BUCKET);
}

/** A fresh bootstrap driver for `env`, or null when it is not configured. Not memoized. */
export function createEnvBootstrapDriver(env: StorageEnv): StorageDriver | null {
  if (!isStorageConfigured(env)) return null;
  return createBootstrapDriver({
    S3_ENDPOINT: env.S3_ENDPOINT as string,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY as string,
    S3_SECRET_KEY: env.S3_SECRET_KEY as string,
  });
}

// Memoized per env object: each service passes its one env module, so this is a
// per-service singleton without a module-level variable in every app.
const memo = new WeakMap<object, StorageDriver | null>();

/** The memoized bootstrap driver for `env`, or null when storage is not configured. */
export function getEnvBootstrapDriver(env: StorageEnv): StorageDriver | null {
  if (memo.has(env)) return memo.get(env) ?? null;
  const driver = createEnvBootstrapDriver(env);
  memo.set(env, driver);
  return driver;
}

/** As getEnvBootstrapDriver, but throws StorageNotConfiguredError (503) when not configured. */
export function requireEnvBootstrapDriver(env: StorageEnv): StorageDriver {
  const driver = getEnvBootstrapDriver(env);
  if (!driver) throw new StorageNotConfiguredError();
  return driver;
}

/**
 * Test hook: pin the driver returned for `env` (null = "not configured"), or pass
 * undefined to drop the pin so the next call re-reads `env`.
 */
export function __setEnvBootstrapDriverForTests(env: StorageEnv, driver: StorageDriver | null | undefined): void {
  if (driver === undefined) memo.delete(env);
  else memo.set(env, driver);
}

/** Build the bootstrap `local` driver from the legacy S3_* env, so the existing
 *  attachment substrate can repoint at the package with no behaviour change
 *  (AB-2). */
export function createBootstrapDriver(env: {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
}): StorageDriver {
  return createDriver(
    { kind: 'local', config: { endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: env.S3_BUCKET } },
    { accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY },
  );
}
