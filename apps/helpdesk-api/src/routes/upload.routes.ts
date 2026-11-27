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

      // #142 / #334: GET /files serves a helpdesk/ key only to the org in its file_upload_owners
      // row, so the owner must be known BEFORE the object is stored. Precedence: the customer's
      // own org, then the portal's tenant org, then the org a ticket from this customer would
      // land in (the first helpdesk_settings row, the same fallback ticket-create.service.ts
      // uses for a request with no org). With none of those the upload is refused rather than
      // returning a URL that 404s for everyone.
      const tenantOrgId = request.tenantContext?.orgId ?? null;
      const ownerRows = (await db.execute(sql`
        SELECT COALESCE(
                 hu.org_id,
                 ${tenantOrgId}::uuid,
                 (SELECT hs.org_id FROM helpdesk_settings hs ORDER BY hs.created_at ASC, hs.id ASC LIMIT 1)
               ) AS org_id
        FROM helpdesk_users hu
        WHERE hu.id = ${request.helpdeskUser!.id}
      `)) as unknown as Array<{ org_id: string | null }>;
      const ownerOrgId = ownerRows[0]?.org_id ?? null;
      if (!ownerOrgId) {
        request.log.warn({ helpdeskUserId: request.helpdeskUser!.id }, 'helpdesk upload refused: no owning org');
        return reply.status(422).send({
          error: {
            code: 'NO_OWNING_ORG',
            message: 'This helpdesk is not linked to an organization yet, so attachments cannot be stored.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const uuid = randomUUID();
      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `helpdesk/${uuid}-${safeFilename}`;

      await uploadFile(env.S3_BUCKET, key, buffer, contentType);

      await db.execute(sql`
        INSERT INTO file_upload_owners (storage_key, org_id, source, uploaded_by)
        VALUES (${key}, ${ownerOrgId}::uuid, 'helpdesk', ${request.helpdeskUser!.id})
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
