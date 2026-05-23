import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBeaconReadAccess, requireBeaconEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as attachmentService from '../services/attachment.service.js';
import { AttachmentError } from '../services/attachment.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { buildBeaconEventPayload } from '../lib/enrich-beacon-event.js';

// 10 MB per-file cap per plan § API routes and services.
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function isAdminRole(role: string, isSuperuser: boolean): boolean {
  return isSuperuser || role === 'admin' || role === 'owner';
}

export default async function attachmentsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  });

  // GET /beacons/:id/attachments — list all attachments on a beacon
  fastify.get<{ Params: { id: string } }>(
    '/beacons/:id/attachments',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_attachment.get')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const attachments = await attachmentService.listAttachments(beacon.id);
      return reply.send({ data: attachments });
    },
  );

  // POST /beacons/:id/attachments — multipart upload
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/attachments',
    {
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireBeaconEditAccess(), shadowOnly('beacon.beacon_attachment.create'), requireScope('read_write')],
    },
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

      const buffer = await file.toBuffer();
      if (buffer.length === 0) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'File is empty',
            details: [],
            request_id: request.id,
          },
        });
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

      const beacon = (request as any).beacon;

      try {
        const attachment = await attachmentService.uploadAttachment({
          filename: file.filename,
          contentType: file.mimetype,
          buffer,
          orgId: request.user!.org_id,
          beaconId: beacon.id,
          uploadedBy: request.user!.id,
        });

        buildBeaconEventPayload(beacon, request.user!.id, {
          attachment: {
            id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.content_type,
            size_bytes: attachment.size_bytes,
            uploaded_by: attachment.uploaded_by,
          },
        })
          .then((payload) =>
            publishBoltEvent(
              'attachment.uploaded',
              'beacon',
              payload,
              request.user!.org_id,
              request.user!.id,
            ),
          )
          .catch(() => {});

        return reply.status(201).send({ data: attachment });
      } catch (err) {
        if (err instanceof AttachmentError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // DELETE /beacons/:id/attachments/:attachmentId
  fastify.delete<{ Params: { id: string; attachmentId: string } }>(
    '/beacons/:id/attachments/:attachmentId',
    { preHandler: [requireAuth, requireBeaconEditAccess(), shadowOnly('beacon.beacon_attachment.delete'), requireScope('read_write')] },
    async (request, reply) => {
      try {
        const withBeacon = await attachmentService.getAttachmentWithBeacon(
          request.params.attachmentId,
        );
        if (!withBeacon) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Attachment not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        const beacon = (request as any).beacon;
        if (withBeacon.attachment.beacon_id !== beacon.id) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Attachment not found on this beacon',
              details: [],
              request_id: request.id,
            },
          });
        }

        const isAdmin = isAdminRole(request.user!.role, request.user!.is_superuser);
        const deleted = await attachmentService.deleteAttachment(
          request.params.attachmentId,
          request.user!.id,
          isAdmin,
        );
        return reply.send({ data: deleted });
      } catch (err) {
        if (err instanceof AttachmentError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );
}
