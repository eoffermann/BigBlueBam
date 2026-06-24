import { parseProviderConfig, type ProviderSecret } from './config.js';
import type { StorageDriver, StorageDriverKind } from './driver.js';
import { S3Driver } from './s3-driver.js';

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
