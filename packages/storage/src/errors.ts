// Shared storage error vocabulary, so every service maps storage failures to the
// same HTTP status and code instead of inventing its own (issues #164, #169).

/** Storage is required but not configured on this server. Maps to 503 STORAGE_NOT_CONFIGURED. */
export class StorageNotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly code = 'STORAGE_NOT_CONFIGURED';
  constructor(
    message = 'File storage is not configured on this server (S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY are required)',
  ) {
    super(message);
    this.name = 'StorageNotConfiguredError';
  }
}

/** Whether a storage error means the object does not exist (as opposed to storage trouble). */
export function isStorageNotFoundError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchObject';
}

/** A storage call did not finish within its time budget. Maps to 504 STORAGE_TIMEOUT. */
export class StorageTimeoutError extends Error {
  readonly statusCode = 504;
  readonly code = 'STORAGE_TIMEOUT';
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Object storage did not answer ${operation} within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'StorageTimeoutError';
  }
}

/** Default budget for one hot-path storage call (a put of up to a few tens of MB). */
export const DEFAULT_STORAGE_TIMEOUT_MS = 30_000;

/**
 * Bound a storage call. The minio client exposes no request timeout, so a stalled
 * endpoint (network partition, blackholed TCP) would otherwise hang the caller
 * forever. On timeout this rejects with StorageTimeoutError; the abandoned request
 * may still finish in the background, so callers must not hold a DB transaction
 * or row lock across the call (issue #169) and should write to a key nothing
 * references yet.
 */
export async function withStorageTimeout<T>(
  operation: string,
  work: Promise<T>,
  timeoutMs: number = DEFAULT_STORAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
