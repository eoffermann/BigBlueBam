import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { uploadFile } from '../services/upload.service.js';
import { requireHelpdeskAuth } from '../plugins/auth.js';

// @fastify/multipart is registered at the root in server.ts so both this
// route and the ticket-scoped attachments route share a single plugin
// instance. File size is capped here per-request (25 MB for the generic
// upload bucket) and the attachments route enforces its own 10 MB cap.
const MAX_FILE_SIZE = 26214400; // 25MB

const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
];

function isAllowedMimeType(mimeType: string): boolean {
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (ALLOWED_MIME_EXACT.includes(mimeType)) return true;
  return false;
}

export default async function helpdeskUploadRoutes(fastify: FastifyInstance) {
  // POST /helpdesk/upload — accept multipart file upload, store in MinIO
  fastify.post(
    '/helpdesk/upload',
    { preHandler: [requireHelpdeskAuth] },
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
      const key = `helpdesk/${uuid}-${safeFilename}`;

      await uploadFile(env.S3_BUCKET, key, buffer, contentType);

      // #142: bind the key to the customer's org (their helpdesk_users.org_id, else the portal's
      // tenant org). The Bam api's GET /files serves a helpdesk/ key only to that org.
      const tenantOrgId = request.tenantContext?.orgId ?? null;
      await db.execute(sql`
        INSERT INTO file_upload_owners (storage_key, org_id, source, uploaded_by)
        SELECT ${key}, COALESCE(hu.org_id, ${tenantOrgId}::uuid), 'helpdesk', hu.id
        FROM helpdesk_users hu
        WHERE hu.id = ${request.helpdeskUser!.id}
          AND COALESCE(hu.org_id, ${tenantOrgId}::uuid) IS NOT NULL
        ON CONFLICT (storage_key) DO NOTHING
      `);

      // Return proxy URL through API
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
}
