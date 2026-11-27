import { randomUUID } from 'node:crypto';
import type { StorageDriver } from '@bigbluebam/storage';

/**
 * Boot-time put, stat, delete check on Bastion's own bucket (spec 9.1).
 *
 * It never blocks boot and never touches readiness: /health/ready stays Postgres and Redis
 * only, so a MinIO outage cannot take Bastion out of rotation. The outcome is kept in memory
 * (bucket_check_status) for the Readiness banner added in a later milestone, and logged in
 * plain language.
 */

export type BucketCheckStatus = 'pending' | 'ok' | 'not_configured' | 'failed';

export interface BucketCheckResult {
  status: BucketCheckStatus;
  bucket: string;
  checked_at: string | null;
  /** Plain-language explanation shown to operators. */
  message: string;
  /** Raw error text for logs; never shown to end users. */
  detail?: string;
}

interface BootLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

let current: BucketCheckResult = {
  status: 'pending',
  bucket: '',
  checked_at: null,
  message: 'The evidence storage check has not run yet.',
};

/** The latest boot check outcome (bucket_check_status). */
export function getBucketCheckStatus(): BucketCheckResult {
  return current;
}

/** The one "evidence storage is working" rule the Readiness banner and Settings share. */
export function bucketStorageOk(): boolean {
  return current.status === 'ok' || current.status === 'pending';
}

const CHECK_PREFIX = '_bastion_boot_check';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runBucketCheck(
  driver: StorageDriver | null,
  bucket: string,
  logger: BootLogger,
  opts: { timeoutMs?: number; now?: () => Date } = {},
): Promise<BucketCheckResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => new Date());

  if (!driver) {
    current = {
      status: 'not_configured',
      bucket,
      checked_at: now().toISOString(),
      message:
        "Evidence storage isn't set up (S3_ENDPOINT, S3_ACCESS_KEY or S3_SECRET_KEY is empty). Bastion is running, but uploading evidence will not work until storage is configured.",
    };
    logger.warn({ bucket_check_status: current.status, bucket }, current.message);
    return current;
  }

  const key = `${CHECK_PREFIX}/${randomUUID()}`;
  const body = Buffer.from('bastion boot check');
  let step = 'write a test file to';
  try {
    logger.info({ bucket, key }, `Checking Bastion evidence storage (bucket "${bucket}")...`);
    await withTimeout(driver.put(key, body, { contentType: 'text/plain', size: body.length }), timeoutMs, 'storage');
    step = 'read back the test file from';
    const stat = await withTimeout(driver.stat(key), timeoutMs, 'storage');
    if (!stat || stat.size !== body.length) {
      throw new Error(`the test file came back ${stat ? `with size ${stat.size}` : 'missing'}`);
    }
    step = 'delete the test file from';
    await withTimeout(driver.delete(key), timeoutMs, 'storage');
    current = {
      status: 'ok',
      bucket,
      checked_at: now().toISOString(),
      message: `Evidence storage is working (bucket "${bucket}").`,
    };
    logger.info({ bucket_check_status: current.status, bucket }, current.message);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (step === 'read back the test file from') {
      // The write landed; do not leave the probe object behind.
      await withTimeout(driver.delete(key), timeoutMs, 'storage').catch(() => {});
    }
    current = {
      status: 'failed',
      bucket,
      checked_at: now().toISOString(),
      message: `Bastion could not ${step} its evidence bucket "${bucket}". Bastion is running, but uploading evidence will fail until storage is fixed. Check S3_ENDPOINT, the S3 keys, and BASTION_S3_BUCKET.`,
      detail,
    };
    logger.error({ bucket_check_status: current.status, bucket, err: detail }, current.message);
  }
  return current;
}
