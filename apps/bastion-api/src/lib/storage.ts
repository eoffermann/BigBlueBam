import {
  createEnvBootstrapDriver,
  isStorageConfigured as isSharedStorageConfigured,
  type StorageDriver,
  type StorageEnv,
} from '@bigbluebam/storage';

/**
 * Bastion's own bucket (spec 3.3, 9.1). Evidence copies, seals and restore records live in
 * BASTION_S3_BUCKET, never the shared uploads bucket, so the shared `/files/*` route can never
 * serve them and the off-site mirror has a single, bounded source.
 *
 * Storage is optional for bastion-api: when the S3 credentials were skipped at deploy time this
 * returns null, the service still starts, and evidence writes report "Evidence storage isn't
 * set up" (later milestones).
 *
 * Issue #164: the "configured" rule and the driver construction are the shared
 * @bigbluebam/storage helper's; only the bucket differs (BASTION_S3_BUCKET in place of
 * S3_BUCKET). Not memoized, so the boot-time bucket check builds its own driver exactly as
 * before.
 */
export interface BastionStorageEnv {
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_REGION: string;
  BASTION_S3_BUCKET: string;
}

function asStorageEnv(env: BastionStorageEnv): StorageEnv {
  return {
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_ACCESS_KEY: env.S3_ACCESS_KEY,
    S3_SECRET_KEY: env.S3_SECRET_KEY,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.BASTION_S3_BUCKET,
  };
}

export function isStorageConfigured(env: BastionStorageEnv): boolean {
  return isSharedStorageConfigured(asStorageEnv(env));
}

export function createBastionStorage(env: BastionStorageEnv): StorageDriver | null {
  return createEnvBootstrapDriver(asStorageEnv(env));
}

/**
 * The off-site evidence mirror (spec 9.7): a separately configured destination, ideally another
 * provider or host, never the shared bucket. Null when any BASTION_BACKUP_S3_* value is unset,
 * which is the one rule for "off-site backup configured" (the Readiness banner, the probe flag and
 * the mirror engine all ask this). Its credentials exist only in bastion-api.
 */
export interface BastionBackupEnv {
  S3_REGION: string;
  BASTION_BACKUP_S3_ENDPOINT?: string;
  BASTION_BACKUP_S3_BUCKET?: string;
  BASTION_BACKUP_S3_ACCESS_KEY?: string;
  BASTION_BACKUP_S3_SECRET_KEY?: string;
}

export function createBackupStorage(env: BastionBackupEnv): StorageDriver | null {
  return createEnvBootstrapDriver({
    S3_ENDPOINT: env.BASTION_BACKUP_S3_ENDPOINT,
    S3_ACCESS_KEY: env.BASTION_BACKUP_S3_ACCESS_KEY,
    S3_SECRET_KEY: env.BASTION_BACKUP_S3_SECRET_KEY,
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.BASTION_BACKUP_S3_BUCKET ?? '',
  });
}

/**
 * A READ-ONLY view of the shared uploads bucket Bin writes to (M5, spec 3.3): manual evidence is
 * copied from the pinned Bin version into Bastion's own bucket at attach. Bastion never writes or
 * deletes here; the only calls made on this driver are getStream and stat.
 */
export function createBinStorage(env: BastionStorageEnv & { S3_BUCKET: string }): StorageDriver | null {
  return createEnvBootstrapDriver({ ...asStorageEnv(env), S3_BUCKET: env.S3_BUCKET });
}
