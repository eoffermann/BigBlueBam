import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import * as Minio from 'minio';
import { env } from '../env.js';
import { and, eq } from 'drizzle-orm';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireChannelMember } from '../middleware/channel-auth.js';
import { getBanterSettingsCached } from '../services/settings-cache.js';
import { db } from '../db/index.js';
import { banterMessageAttachments, banterMessages } from '../db/schema/index.js';
import { dispositionFor, isServableAttachmentKey } from '../lib/attachment-download.js';

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
      port: Number.parseInt(url.port || '9000', 10),
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

      // Issue #142: no /files/ URL any more. The object is only reachable after it
      // is attached to a message, through the channel-authorized download route
      // (each attachment in a message response carries that `url`).
      return reply.status(201).send({
        data: {
          url: null,
          key,
          filename: file.filename,
          content_type: contentType,
          size_bytes: buffer.length,
        },
      });
    },
  );

  // GET /v1/channels/:id/attachments/:attachmentId — authorized attachment
  // download (issue #142). requireChannelMember applies the message list's read
  // rule (org match, archived hidden, public readable by the org, private only
  // for members, 404 otherwise), so removing someone from a channel revokes
  // their access to its files. The attachment must belong to a live message in
  // THIS channel, and only keys Banter itself writes are served.
  fastify.get(
    '/v1/channels/:id/attachments/:attachmentId',
    { preHandler: [requireAuth, requireChannelMember] },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().uuid(), attachmentId: z.string().uuid() })
        .safeParse(request.params);
      const notFound = () =>
        reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Attachment not found', details: [], request_id: request.id },
        });
      if (!params.success) return notFound();

      const [row] = await db
        .select({
          filename: banterMessageAttachments.filename,
          content_type: banterMessageAttachments.content_type,
          storage_key: banterMessageAttachments.storage_key,
          is_stub: banterMessageAttachments.is_stub,
        })
        .from(banterMessageAttachments)
        .innerJoin(banterMessages, eq(banterMessages.id, banterMessageAttachments.message_id))
        .where(
          and(
            eq(banterMessageAttachments.id, params.data.attachmentId),
            eq(banterMessages.channel_id, params.data.id),
            eq(banterMessages.is_deleted, false),
          ),
        )
        .limit(1);

      const orgId = request.user?.org_id ?? '';
      if (!row || row.is_stub || !isServableAttachmentKey(row.storage_key, orgId)) {
        return notFound();
      }

      try {
        const client = getMinioClient();
        const stat = await client.statObject(env.S3_BUCKET, row.storage_key);
        const stream = await client.getObject(env.S3_BUCKET, row.storage_key);
        return reply
          .header('Content-Type', row.content_type)
          .header('Content-Length', stat.size)
          .header('Content-Disposition', dispositionFor(row.content_type, row.filename))
          .header('Cache-Control', 'private, no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Content-Security-Policy', 'sandbox')
          .send(stream);
      } catch {
        return notFound();
      }
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
