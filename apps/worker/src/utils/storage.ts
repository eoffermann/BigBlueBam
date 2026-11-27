// Worker-side object storage over the platform bucket (S3_BUCKET), through the
// shared @bigbluebam/storage driver (issue #176). The S3 settings are parsed with
// the worker's own env rule (s3EnvSchema in env.ts): no default credentials, so
// without S3_ACCESS_KEY / S3_SECRET_KEY storage is "not configured". The driver
// is bound to the bucket and creates it on first write (the database-backup job
// may be the first writer on a fresh stack).
//
// Read helpers return null / false / [] when storage is missing or unreachable so
// callers can degrade; write helpers throw (StorageNotConfiguredError when not
// configured) so callers can mark the work failed.

import { createReadStream, createWriteStream } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  __setEnvBootstrapDriverForTests,
  getEnvBootstrapDriver,
  isStorageConfigured,
  requireEnvBootstrapDriver,
  type StorageDriver,
} from '@bigbluebam/storage';
import { s3EnvSchema, type S3Env } from '../env.js';

let storageEnv: S3Env | null = null;

/** The worker's S3 settings, parsed once from process.env with the env.ts rule. */
export function workerStorageEnv(): S3Env {
  if (!storageEnv) storageEnv = s3EnvSchema.parse(process.env);
  return storageEnv;
}

/** The shared "is storage configured" rule over the worker's S3 settings. */
export const isWorkerStorageConfigured = (): boolean => isStorageConfigured(workerStorageEnv());

/** The worker's shared driver over S3_BUCKET, or null when storage is not configured. */
export const getWorkerStorageDriver = (): StorageDriver | null => getEnvBootstrapDriver(workerStorageEnv());
const driverOrNull = getWorkerStorageDriver;
const requireDriver = (): StorageDriver => requireEnvBootstrapDriver(workerStorageEnv());

/** Test hook: inject a driver (null = not configured), or undefined to re-read env. */
export function __setWorkerStorageDriverForTests(d: StorageDriver | null | undefined): void {
  __setEnvBootstrapDriverForTests(workerStorageEnv(), d);
}

export interface StoredObjectStat {
  size: number;
  contentType: string | null;
}

/**
 * Stat an object. Returns null if the object does not exist (or storage is
 * unreachable or not configured), so the caller can distinguish "stored" from
 * "missing".
 */
export async function statObject(key: string): Promise<StoredObjectStat | null> {
  try {
    const driver = driverOrNull();
    if (!driver) return null;
    const s = await driver.stat(key);
    if (!s) return null;
    return { size: s.size, contentType: s.contentType ?? null };
  } catch {
    return null;
  }
}

/**
 * Read an object fully into a Buffer. Used by the Bin AV-scan job and the extract
 * jobs. Returns null if the object is missing or unreadable so the caller can mark
 * the work `error`.
 */
export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const driver = driverOrNull();
    if (!driver) return null;
    const { stream } = await driver.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Stream an object straight to a local file (ffmpeg and pg_restore need a file
 * on disk). Returns false if the object is missing/unreadable.
 */
export async function downloadObjectToFile(key: string, destPath: string): Promise<boolean> {
  try {
    const driver = driverOrNull();
    if (!driver) return false;
    const { stream } = await driver.getStream(key);
    await pipeline(stream, createWriteStream(destPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload a local file to an object key. Used for backup archives and transcoded
 * artifacts. Throws on failure so the caller can mark the work failed.
 */
export async function putObjectFromFile(key: string, srcPath: string, contentType: string): Promise<void> {
  const driver = requireDriver();
  const { size } = await fsStat(srcPath);
  await driver.put(key, createReadStream(srcPath), { contentType, size });
}

/**
 * Presigned GET URL for an object (24h default), or null when it cannot be
 * minted. Surfaced as a direct download link alongside the app-served path.
 */
export async function presignedGetUrl(key: string, expirySeconds = 24 * 60 * 60): Promise<string | null> {
  try {
    const driver = driverOrNull();
    if (!driver?.presignGet) return null;
    return await driver.presignGet(key, expirySeconds);
  } catch {
    return null;
  }
}

/**
 * Upload an in-memory Buffer to an object key (Blip captures, thumbnails, JSONL
 * exports). Throws on failure so the caller decides what to do.
 */
export async function putObjectBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  await requireDriver().put(key, body, { contentType, size: body.length });
}

/**
 * List every object key under a prefix (paged, bounded by `limit`). The object
 * store has no prefix delete, so capture GC (Blip §11.2) is list-then-delete.
 * Returns what it has on error so a GC sweep degrades to a partial or no-op run.
 */
export async function listObjectKeys(prefix: string, limit = 100_000): Promise<string[]> {
  const keys: string[] = [];
  try {
    const driver = driverOrNull();
    if (!driver) return keys;
    let cursor: string | undefined;
    do {
      const page = await driver.list(prefix, cursor);
      for (const o of page.objects) {
        keys.push(o.key);
        if (keys.length >= limit) return keys;
      }
      cursor = page.cursor;
    } while (cursor);
  } catch {
    // degrade
  }
  return keys;
}

/** Delete a single object. Best-effort: never throws mid-sweep. */
export async function removeObject(key: string): Promise<void> {
  try {
    await driverOrNull()?.delete(key);
  } catch {
    /* swallow */
  }
}
