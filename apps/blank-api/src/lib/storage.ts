// MinIO/S3 storage helper for Blank form-submission file uploads.
//
// Mirrors apps/api/src/services/upload.service.ts and the Beacon/Bill
// equivalents: there is no shared storage package, so each app instantiates
// its own `minio` client from the same S3_* env vars and shares the platform
// `bigbluebam-uploads` bucket. Blank objects are namespaced under a `blank/`
// key prefix so they never collide with Bam task attachments (`uploads/...`).
//
// Downloads are NOT served by the shared /files/ Bam route (that route enforces
// Bam auth + bam.file.list). Blank submission files are served by an
// org-scoped, authenticated blank-api route (GET /v1/submissions/:id/files/:idx)
// that streams from MinIO after confirming the caller owns the submission.

import * as Minio from 'minio';
import { env } from '../env.js';

const endpoint = new URL(env.S3_ENDPOINT);

const minioClient = new Minio.Client({
  endPoint: endpoint.hostname,
  port: Number(endpoint.port) || (endpoint.protocol === 'https:' ? 443 : 9000),
  useSSL: endpoint.protocol === 'https:',
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
  region: env.S3_REGION,
});

const ensuredBuckets = new Set<string>();

export async function ensureBucket(bucketName: string): Promise<void> {
  if (ensuredBuckets.has(bucketName)) return;
  const exists = await minioClient.bucketExists(bucketName);
  if (!exists) {
    await minioClient.makeBucket(bucketName, env.S3_REGION);
  }
  ensuredBuckets.add(bucketName);
}

export async function uploadFile(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await ensureBucket(env.S3_BUCKET);
  await minioClient.putObject(env.S3_BUCKET, key, buffer, buffer.length, {
    'Content-Type': contentType,
  });
}

export async function getFileStream(key: string) {
  const stat = await minioClient.statObject(env.S3_BUCKET, key);
  const stream = await minioClient.getObject(env.S3_BUCKET, key);
  return {
    stream,
    contentType: stat.metaData?.['content-type'] ?? 'application/octet-stream',
    size: stat.size,
  };
}

export async function statFile(key: string) {
  return minioClient.statObject(env.S3_BUCKET, key);
}

export async function deleteFile(key: string): Promise<void> {
  try {
    await minioClient.removeObject(env.S3_BUCKET, key);
  } catch {
    // Swallow — the submission row is the source of truth.
  }
}

/**
 * Build the MinIO object key for a Blank submission upload. The submission id
 * is not known at upload time (the file is uploaded before the response is
 * submitted), so we namespace by org + form + a fresh uuid.
 */
export function buildBlankStorageKey(
  orgId: string,
  formId: string,
  uuid: string,
  filename: string,
): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return `blank/${orgId}/${formId}/${uuid}-${safe}`;
}
