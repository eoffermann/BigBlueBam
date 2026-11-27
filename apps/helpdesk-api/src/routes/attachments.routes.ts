import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tickets } from '../db/schema/tickets.js';
import { helpdeskTicketAttachments } from '../db/schema/helpdesk-ticket-attachments.js';
import { requireHelpdeskAuth } from '../plugins/auth.js';
import { uploadFile, getFileUrl, deleteFile, StorageNotConfiguredError } from '../services/upload.service.js';

/**
 * G6: ticket-scoped file attachments backed by MinIO.
 *
 * Storage key convention:
 *   helpdesk-attachments/<ticket_id>/<uuid>/<safe-filename>
 *
 * The `<uuid>` segment prevents collisions when two uploads share a
 * filename, and isolates delete/list operations per row. Rows hold the
 * authoritative metadata; the GET response returns a short-lived presigned
 * URL per attachment so customers can download without an API-proxied
 * stream.
 *
 * Wave 2 cap is 10 MB per upload (the plan value; the generic upload route
 * uses 25 MB). A future ClamAV scanner would flip `scan_status` from the
 * default `pending` to `clean` or `infected`; for now we leave it as
 * `pending` and rely on mime-type allowlisting to gate obvious abuse.
 */
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
];

function isAllowedMimeType(mimeType: string): boolean {
  if (ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
  if (ALLOWED_MIME_EXACT.includes(mimeType)) return true;
  return false;
}

export default async function attachmentRoutes(fastify: FastifyInstance) {
  // @fastify/multipart is registered inside upload.routes.ts. Both route
  // files live in the same Fastify instance so we do not re-register it
  // here; the shared encapsulation context gives both routes access.

  // GET /helpdesk/tickets/:id/attachments - owner-only list with presigned URLs.
  fastify.get(
    '/helpdesk/tickets/:id/attachments',
    { preHandler: [requireHelpdeskAuth] },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id } = request.params as { id: string };

      // HB-51 anti-enumeration: 404-everywhere if the ticket exists but is
      // not owned by the caller.
      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rows = await db
        .select()
        .from(helpdeskTicketAttachments)
        .where(eq(helpdeskTicketAttachments.ticket_id, id))
        .orderBy(desc(helpdeskTicketAttachments.created_at));

      // Materialize presigned URLs lazily. 24h expiry matches the default
      // in upload.service.getFileUrl.
      const withUrls = await Promise.all(
        rows.map(async (row) => {
          let url: string | null = null;
          try {
            url = await getFileUrl(row.storage_key);
          } catch (err) {
            request.log.warn(
              { err, attachment_id: row.id },
              'Failed to presign attachment URL; returning metadata without url',
            );
          }
          return {
            id: row.id,
            ticket_id: row.ticket_id,
            filename: row.filename,
            content_type: row.content_type,
            size_bytes: row.size_bytes,
            scan_status: row.scan_status,
            created_at: row.created_at,
            url,
          };
        }),
      );

      return reply.send({ data: withUrls });
    },
  );

  // POST /helpdesk/tickets/:id/attachments - multipart upload, 10 MB cap.
  fastify.post(
    '/helpdesk/tickets/:id/attachments',
    {
      preHandler: [requireHelpdeskAuth],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id } = request.params as { id: string };

      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

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

      if (!isAllowedMimeType(file.mimetype)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: `File type "${file.mimetype}" is not allowed`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const buffer = await file.toBuffer();
      if (buffer.length > MAX_ATTACHMENT_SIZE) {
        return reply.status(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `File exceeds maximum size of ${MAX_ATTACHMENT_SIZE} bytes`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const safeFilename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 256);
      const uuid = randomUUID();
      const storageKey = `helpdesk-attachments/${id}/${uuid}/${safeFilename}`;

      try {
        await uploadFile(storageKey, buffer, file.mimetype);
      } catch (err) {
        // Storage not configured answers 503 STORAGE_NOT_CONFIGURED (issue #176).
        if (err instanceof StorageNotConfiguredError) throw err;
        request.log.error({ err }, 'Failed to upload attachment to object storage');
        return reply.status(500).send({
          error: {
            code: 'STORAGE_ERROR',
            message: 'Failed to store attachment',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [row] = await db
        .insert(helpdeskTicketAttachments)
        .values({
          ticket_id: id,
          uploaded_by: user.id,
          filename: file.filename.slice(0, 512),
          content_type: file.mimetype.slice(0, 128),
          size_bytes: buffer.length,
          storage_key: storageKey,
          scan_status: 'pending',
        })
        .returning();

      let presignedUrl: string | null = null;
      try {
        presignedUrl = await getFileUrl(storageKey);
      } catch {
        // Non-fatal: caller can re-fetch via GET.
      }

      return reply.status(201).send({
        data: {
          id: row?.id ?? null,
          ticket_id: id,
          filename: file.filename,
          content_type: file.mimetype,
          size_bytes: buffer.length,
          scan_status: 'pending',
          url: presignedUrl,
        },
      });
    },
  );

  // DELETE /helpdesk/tickets/:id/attachments/:attachmentId - owner-only delete.
  fastify.delete(
    '/helpdesk/tickets/:id/attachments/:attachmentId',
    { preHandler: [requireHelpdeskAuth] },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id, attachmentId } = request.params as { id: string; attachmentId: string };

      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Ownership + ticket-scope: the delete is authorized only if the
      // attachment belongs to this ticket AND was uploaded by the caller.
      // (Agents get a future parallel route under /helpdesk/agents.)
      const [row] = await db
        .select()
        .from(helpdeskTicketAttachments)
        .where(
          and(
            eq(helpdeskTicketAttachments.id, attachmentId),
            eq(helpdeskTicketAttachments.ticket_id, id),
            eq(helpdeskTicketAttachments.uploaded_by, user.id),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Attachment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Best-effort storage cleanup. DB row is the source of truth; if the
      // MinIO delete fails we still remove the row so the customer sees it
      // gone and the orphaned object can be swept by a future GC job.
      try {
        await deleteFile(row.storage_key);
      } catch (err) {
        request.log.warn(
          { err, attachment_id: row.id },
          'Failed to delete attachment object from storage; removing DB row anyway',
        );
      }

      await db
        .delete(helpdeskTicketAttachments)
        .where(eq(helpdeskTicketAttachments.id, row.id));

      return reply.send({ data: { id: row.id, deleted: true } });
    },
  );
}
