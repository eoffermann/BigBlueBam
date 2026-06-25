// Worker-side MinIO/S3 helper. Mirrors the per-app pattern (apps/api,
// apps/blank-api): there is no shared storage package, so the worker
// instantiates its own `minio` client from the S3_* env vars and shares the
// platform `bigbluebam-uploads` bucket. Used by the Blank file-process job to
// confirm uploaded submission objects actually landed and to mint download
// URLs for the stored objects.

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as Minio from 'minio';

const endpoint = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');

export const S3_BUCKET = process.env.S3_BUCKET ?? 'bigbluebam-uploads';

const minioClient = new Minio.Client({
  endPoint: endpoint.hostname,
  port: Number(endpoint.port) || (endpoint.protocol === 'https:' ? 443 : 9000),
  useSSL: endpoint.protocol === 'https:',
  accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  region: process.env.S3_REGION ?? 'us-east-1',
});

export interface StoredObjectStat {
  size: number;
  contentType: string | null;
}

/**
 * Stat an object. Returns null if the object does not exist (or MinIO is
 * unreachable), so the caller can distinguish "stored" from "missing".
 */
export async function statObject(key: string): Promise<StoredObjectStat | null> {
  try {
    const stat = await minioClient.statObject(S3_BUCKET, key);
    return {
      size: stat.size,
      contentType: stat.metaData?.['content-type'] ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Read an object fully into a Buffer. Used by the Bin AV-scan job to inspect
 * uploaded bytes (heuristic signature scan, or stream to clamd). Returns null
 * if the object is missing or unreadable so the caller can mark scan `error`.
 */
export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const stream = await minioClient.getObject(S3_BUCKET, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Stream an object straight to a local file. Used by the media-transcode job:
 * ffmpeg needs a seekable file on disk, not a buffer. Returns false if the
 * object is missing/unreadable.
 */
export async function downloadObjectToFile(key: string, destPath: string): Promise<boolean> {
  try {
    const stream = await minioClient.getObject(S3_BUCKET, key);
    await pipeline(stream, createWriteStream(destPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload a local file to an object key (fputObject). Used to store transcoded
 * proxy/poster artifacts. Throws on failure so the caller can mark the asset
 * transcode_status='error'.
 */
export async function putObjectFromFile(
  key: string,
  srcPath: string,
  contentType: string,
): Promise<void> {
  await minioClient.fPutObject(S3_BUCKET, key, srcPath, { 'Content-Type': contentType });
}

/**
 * Presigned GET URL for an object (24h default). Used to surface a directly
 * downloadable link in processed_files alongside the app-served proxy path.
 */
export async function presignedGetUrl(
  key: string,
  expirySeconds = 24 * 60 * 60,
): Promise<string | null> {
  try {
    return await minioClient.presignedGetObject(S3_BUCKET, key, expirySeconds);
  } catch {
    return null;
  }
}
