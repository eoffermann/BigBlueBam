// Worker-side MinIO/S3 helper. Mirrors the per-app pattern (apps/api,
// apps/blank-api): there is no shared storage package, so the worker
// instantiates its own `minio` client from the S3_* env vars and shares the
// platform `bigbluebam-uploads` bucket. Used by the Blank file-process job to
// confirm uploaded submission objects actually landed and to mint download
// URLs for the stored objects.

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
