import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { env } from '../env.js';
import { uploadFile, getFileStream } from '../services/upload.service.js';
import { StorageNotConfiguredError } from '../lib/storage-driver.js';
import { updateProfile } from '../services/auth.service.js';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { recordUploadOwner, uploadOwnerOrg } from '../services/file-ownership.service.js';

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

/**
 * Issue #123: GET /files/* used to stream ANY key in the shared bucket to any signed-in
 * user, including org-prefixed objects that Bin, Bay, Blip and others write through
 * @bigbluebam/storage, with `Cache-Control: public`. It now serves an explicit allowlist.
 *
 * - FILES_PUBLIC_PREFIXES: the prefix this route exists for. Avatars are shown to
 *   other users and are safe to cache publicly.
 * - FILES_LEGACY_PRIVATE_PREFIXES: keys that existing features still hand out as
 *   `/files/<key>` URLs, embedded in stored content. They are served with
 *   `Cache-Control: private, no-store`, and (#142) only to a caller whose ACTIVE ORG owns the
 *   key per file_upload_owners: both upload routes record the owner, migration 0310 backfilled
 *   existing objects from the content that links them, and a key with no owner row 404s. So a
 *   URL no longer works across orgs, and leaving an org revokes it.
 *     bill/receipts/    REMOVED (#145): bill-api GET /v1/expenses/:id/receipt.
 *     banter/uploads/   REMOVED (#142): banter-api GET /v1/channels/:id/attachments/:attId,
 *                       authorized by channel membership.
 *     uploads/          Org-bound (#142). apps/api POST /upload: task description, comment and
 *                       subtask images, task attachment rows, Bureau floor underlays.
 *     helpdesk/         Org-bound (#142). helpdesk-api POST /helpdesk/upload: ticket
 *                       description and message images, read by Bam agents of the org.
 *   Still not per-record: within the owning org a member who lost access to one project can
 *   still open an image URL they saw there. Closing that needs a per-entity owner (task,
 *   ticket) on each row; the org binding is the tenant boundary.
 * Do not add a prefix here for new work; serve new objects from the owning app.
 */
export const FILES_PUBLIC_PREFIXES = ['avatars/'] as const;
export const FILES_LEGACY_PRIVATE_PREFIXES = ['uploads/', 'helpdesk/'] as const;

/** Returns how a /files/ key may be served, or null when it must 404. */
export function classifyFilesKey(key: string): 'public' | 'private' | null {
  if (!key || key.startsWith('/') || key.includes('\\')) return null;
  // Reject any dot segment so a prefix match cannot be walked out of.
  if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
  if (FILES_PUBLIC_PREFIXES.some((p) => key.startsWith(p))) return 'public';
  if (FILES_LEGACY_PRIVATE_PREFIXES.some((p) => key.startsWith(p))) return 'private';
  return null;
}

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

      await uploadFile(key, buffer, contentType);
      // #142: bind the key to the uploader's active org; GET /files serves it to that org only.
      const uploader = request.user;
      if (uploader) await recordUploadOwner(key, uploader.active_org_id, 'bam', uploader.id);

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
      await uploadFile(key, buffer, detected.mime);
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

  // GET /files/*  - proxy file downloads from MinIO (BAM-005: require auth).
  // Only keys under FILES_PUBLIC_PREFIXES / FILES_LEGACY_PRIVATE_PREFIXES are served
  // (issue #123); everything else is 404.
  fastify.get(
    '/files/*',
    { preHandler: [requireAuth, shadowOnly('bam.file.list')] },
    async (request, reply) => {
      const key = (request.params as Record<string, string>)['*'];
      const access = key ? classifyFilesKey(key) : null;

      if (key && !access) {
        // Issue #123: anything outside the allowlisted prefixes (org-prefixed objects
        // written through @bigbluebam/storage by Bin, Bay, Blip and others) belongs to
        // its owning app's authorized download route. 404, not 403: do not confirm the
        // object exists.
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'File not found',
            details: [],
            request_id: request.id,
          },
        });
      }

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

      if (access === 'private') {
        // #142: a legacy upload is served only to the org that owns it (file_upload_owners,
        // written at upload time and backfilled by migration 0310). Another org, or a key
        // nothing records, gets the same 404 as a missing object.
        const owner = await uploadOwnerOrg(key);
        if (!owner || owner !== request.user?.active_org_id) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'File not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      try {
        const { stream, contentType, size } = await getFileStream(key);
        reply.header('Content-Type', contentType);
        reply.header('Content-Length', size);
        reply.header(
          'Cache-Control',
          access === 'public' ? 'public, max-age=86400' : 'private, no-store',
        );
        return reply.send(stream);
      } catch (err) {
        // Storage not configured is a 503 (issue #176), not a missing file.
        if (err instanceof StorageNotConfiguredError) throw err;
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
