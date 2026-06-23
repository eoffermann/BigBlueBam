import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../env.js';
import { uploadFile, getFileStream } from '../services/upload.service.js';
import { updateProfile } from '../services/auth.service.js';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';

const MAX_FILE_SIZE = env.UPLOAD_MAX_FILE_SIZE; // 25MB

const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

// BAM-006: SVG can contain embedded scripts — always block it.
const BLOCKED_MIME_TYPES = ['image/svg+xml'];

function isAllowedMimeType(mimeType: string): boolean {
  if (BLOCKED_MIME_TYPES.includes(mimeType)) return false;
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (ALLOWED_MIME_EXACT.includes(mimeType)) return true;
  return false;
}

export default async function uploadRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE,
    },
  });

  // POST /upload — accept multipart file upload, store in MinIO
  fastify.post(
    '/upload',
    { preHandler: [requireAuth, fastify.requireCan('bam.upload.create')] },
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

      // BAM-006: Magic-byte MIME validation — verify actual file content
      // matches claimed type. text/plain has no magic bytes so skip detection.
      if (contentType !== 'text/plain') {
        const detected = await fileTypeFromBuffer(buffer);
        if (!detected || !isAllowedMimeType(detected.mime)) {
          return reply.status(400).send({
            error: {
              code: 'BAD_REQUEST',
              message: `File content does not match an allowed type (detected: ${detected?.mime ?? 'unknown'})`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${MAX_FILE_SIZE} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const uuid = randomUUID();
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `uploads/${uuid}-${safeFilename}`;

      await uploadFile(env.S3_BUCKET, key, buffer, contentType);

      // Return a proxy URL through our API (not a direct MinIO URL)
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

  // POST /auth/me/avatar — upload a profile picture for the current user.
  // Auth-only (no extra permission): every user may set their own avatar.
  // Images only, magic-byte validated, SVG blocked (BAM-006). Stores under
  // avatars/ and sets users.avatar_url to the /files/ proxy path server-side,
  // so the client never has to round-trip the URL through the profile schema.
  const AVATAR_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };

  fastify.post(
    '/auth/me/avatar',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'No file provided', details: [], request_id: request.id },
        });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File exceeds maximum size of ${MAX_FILE_SIZE} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      // Magic-byte validation: the real content must be a supported raster
      // image (claimed mimetype is not trusted; SVG is never an option here).
      const detected = await fileTypeFromBuffer(buffer);
      const ext = detected ? AVATAR_EXT[detected.mime] : undefined;
      if (!detected || !ext) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `Avatar must be a PNG, JPEG, GIF, or WebP image (detected: ${detected?.mime ?? 'unknown'})`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const userId = request.user!.id;
      const key = `avatars/${userId}-${randomUUID()}.${ext}`;
      await uploadFile(env.S3_BUCKET, key, buffer, detected.mime);
      const avatarUrl = `/files/${key}`;

      const updated = await updateProfile(userId, { avatar_url: avatarUrl });
      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'User not found', details: [], request_id: request.id },
        });
      }

      return reply.status(201).send({ data: { avatar_url: avatarUrl } });
    },
  );

  // GET /files/*  — proxy file downloads from MinIO (BAM-005: require auth)
  fastify.get(
    '/files/*',
    { preHandler: [requireAuth, shadowOnly('bam.file.list')] },
    async (request, reply) => {
      const key = (request.params as Record<string, string>)['*'];

      if (!key) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'File key is required',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const { stream, contentType, size } = await getFileStream(env.S3_BUCKET, key);
        reply.header('Content-Type', contentType);
        reply.header('Content-Length', size);
        reply.header('Cache-Control', 'public, max-age=86400');
        return reply.send(stream);
      } catch {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'File not found',
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );
}
