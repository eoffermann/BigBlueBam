import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import * as Minio from 'minio';
import { env } from '../env.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { getBanterSettingsCached } from '../services/settings-cache.js';

const DEFAULT_MAX_FILE_SIZE_MB = 25;
// Absolute cap: the multipart plugin needs a static ceiling. Org-specific
// limits are enforced below via the max_file_size_mb setting.
const ABSOLUTE_MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB hard ceiling

async function getOrgMaxFileSizeBytes(orgId: string): Promise<number> {
  const settings = await getBanterSettingsCached(orgId);
  const mb = settings?.max_file_size_mb ?? DEFAULT_MAX_FILE_SIZE_MB;
  return mb * 1024 * 1024;
}

const BLOCKED_MIME_TYPES = ['image/svg+xml'];
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/gzip',
];

function isAllowedMimeType(mimeType: string): boolean {
  if (BLOCKED_MIME_TYPES.includes(mimeType)) return false;
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (ALLOWED_MIME_EXACT.includes(mimeType)) return true;
  return false;
}

let minioClient: Minio.Client | null = null;

function getMinioClient(): Minio.Client {
  if (!minioClient) {
    const url = new URL(env.S3_ENDPOINT);
    minioClient = new Minio.Client({
      endPoint: url.hostname,
      port: parseInt(url.port || '9000', 10),
      useSSL: url.protocol === 'https:',
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return minioClient;
}

export default async function fileRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: {
      fileSize: ABSOLUTE_MAX_FILE_SIZE,
    },
  });

  // POST /v1/files/upload — multipart file upload to MinIO
  fastify.post(
    '/v1/files/upload',
    { preHandler: [requireAuth, fastify.requireCan('banter.file_upload.create'), requireScope('read_write')] },
    async (request, reply) => {
      const file = await request.file();

      if (!file) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'No file provided',
            details: [],
            request_id: request.id,
          },
        });
      }

      const contentType = file.mimetype;

      if (!isAllowedMimeType(contentType)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File type "${contentType}" is not allowed`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const buffer = await file.toBuffer();

      const maxFileSize = await getOrgMaxFileSizeBytes(request.user!.org_id);
      if (buffer.length > maxFileSize) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${maxFileSize} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const uuid = randomUUID();
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `banter/uploads/${uuid}-${safeFilename}`;

      const client = getMinioClient();

      // Ensure bucket exists
      const bucketExists = await client.bucketExists(env.S3_BUCKET);
      if (!bucketExists) {
        await client.makeBucket(env.S3_BUCKET, env.S3_REGION);
      }

      await client.putObject(env.S3_BUCKET, key, buffer, buffer.length, {
        'Content-Type': contentType,
      });

      const url = `/files/${key}`;

      return reply.status(201).send({
        data: {
          url,
          key,
          filename: file.filename,
          content_type: contentType,
          size_bytes: buffer.length,
        },
      });
    },
  );

  // POST /v1/files/presigned-upload — generate a presigned PUT URL
  fastify.post(
    '/v1/files/presigned-upload',
    { preHandler: [requireAuth, fastify.requireCan('banter.file_presigned_upload.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = z
        .object({
          filename: z.string().min(1).max(255),
          content_type: z.string().min(1).max(255),
          size_bytes: z.number().int().nonnegative().optional(),
        })
        .parse(request.body);

      const maxFileSize = await getOrgMaxFileSizeBytes(request.user!.org_id);
      if (body.size_bytes !== undefined && body.size_bytes > maxFileSize) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${maxFileSize} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      if (!isAllowedMimeType(body.content_type)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File type "${body.content_type}" is not allowed`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const uuid = randomUUID();
      const safeFilename = body.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `banter/uploads/${uuid}-${safeFilename}`;

      const client = getMinioClient();

      // Ensure bucket exists
      const bucketExists = await client.bucketExists(env.S3_BUCKET);
      if (!bucketExists) {
        await client.makeBucket(env.S3_BUCKET, env.S3_REGION);
      }

      const expiresIn = 3600; // 1 hour
      const uploadUrl = await client.presignedPutObject(env.S3_BUCKET, key, expiresIn);

      return reply.status(201).send({
        data: {
          upload_url: uploadUrl,
          key,
          expires_in: expiresIn,
          max_size_bytes: maxFileSize,
        },
      });
    },
  );
}
