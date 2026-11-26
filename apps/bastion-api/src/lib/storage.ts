import { createBootstrapDriver, type StorageDriver } from '@bigbluebam/storage';

/**
 * Bastion's own bucket (spec 3.3, 9.1). Evidence copies, seals and restore records live in
 * BASTION_S3_BUCKET, never the shared uploads bucket, so the shared `/files/*` route can never
 * serve them and the off-site mirror has a single, bounded source.
 *
 * Storage is optional for bastion-api: when the S3 credentials were skipped at deploy time this
 * returns null, the service still starts, and evidence writes report "Evidence storage isn't
 * set up" (later milestones).
 */
export interface BastionStorageEnv {
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_REGION: string;
  BASTION_S3_BUCKET: string;
}

export function isStorageConfigured(env: BastionStorageEnv): boolean {
  return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY && env.S3_SECRET_KEY && env.BASTION_S3_BUCKET);
}

export function createBastionStorage(env: BastionStorageEnv): StorageDriver | null {
  const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY || !env.BASTION_S3_BUCKET) return null;
  return createBootstrapDriver({
    S3_ENDPOINT,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.BASTION_S3_BUCKET,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
  });
}
