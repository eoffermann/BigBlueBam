import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  getAttachmentMetaById,
  listAttachmentsForParent,
  SUPPORTED_PARENT_TYPES,
  SUPPORTED_SCAN_STATUSES,
  MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT,
} from '../services/attachment-meta.service.js';

/**
 * Federated attachment metadata routes (AGENTIC_TODO §17, Wave 4).
 *
 *   GET /v1/attachments/:id
 *     -> 200 { data: AttachmentMeta }
 *     -> 404 NOT_FOUND
 *     -> 403 FORBIDDEN { reason }
 *
 *   GET /v1/attachments?entity_type=&entity_id=&limit=&scan_status=
 *     -> 200 { data: AttachmentMeta[], meta: { limit, scan_status, entity_type, entity_id } }
 *     -> 400 UNSUPPORTED_PARENT_TYPE { supported_entity_types }
 *     -> 404 NOT_FOUND
 *     -> 403 FORBIDDEN { reason }
 *
 * Backed by the federated dispatcher in attachment-meta.service.ts.
 * Every read is preflighted against visibility.service first so
 * unauthorized callers cannot enumerate metadata across the Bam /
 * helpdesk / beacon attachment tables. See the service file for the
 * full can_access-first protocol.
 */

export default async function attachmentMetaRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/v1/attachments/:id',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.attachment.get')],
      config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const idSchema = z.string().uuid();
      const parsed = idSchema.safeParse(request.params.id);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'attachment id must be a UUID',
            details: parsed.error.issues.map((i) => ({
              field: 'id',
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const result = await getAttachmentMetaById(request.user!.id, parsed.data);
      if (result.ok) {
        return reply.send({ data: result.data });
      }

      if (result.error.code === 'NOT_FOUND') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Attachment not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      // FORBIDDEN or UNSUPPORTED_PARENT_TYPE. 'reason' only exists on the
      // FORBIDDEN branch; narrow first so tsc doesn't widen the error type.
      const reason = result.error.code === 'FORBIDDEN' ? result.error.reason : result.error.code;
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Access to this attachment is denied',
          details: [{ field: 'reason', issue: reason }],
          request_id: request.id,
        },
      });
    },
  );

  fastify.get(
    '/v1/attachments',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.attachment.list')],
      config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const querySchema = z.object({
        entity_type: z.string().min(1).max(64),
        entity_id: z.string().uuid(),
        // .default(...) already makes the field optional in the parsed
        // output; chaining .optional() after it trips a TS overload
        // mismatch under zod's type surface.
        limit: z.coerce.number().int().positive().max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
        scan_status: z.enum(SUPPORTED_SCAN_STATUSES).optional(),
      });
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid attachment_list query parameters',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { entity_type, entity_id, limit, scan_status } = parsed.data;

      const result = await listAttachmentsForParent(
        request.user!.id,
        entity_type,
        entity_id,
        { limit, scanStatus: scan_status },
      );

      if (result.ok) {
        return reply.send({
          data: result.data,
          meta: {
            entity_type,
            entity_id,
            limit: limit ?? DEFAULT_LIST_LIMIT,
            scan_status: scan_status ?? null,
            count: result.data.length,
          },
        });
      }

      if (result.error.code === 'UNSUPPORTED_PARENT_TYPE') {
        return reply.status(400).send({
          error: {
            code: 'UNSUPPORTED_PARENT_TYPE',
            message: `entity_type '${entity_type}' is not a supported attachment parent. See supported_entity_types.`,
            details: [],
            request_id: request.id,
            supported_entity_types: result.error.supported,
          },
        });
      }

      if (result.error.code === 'NOT_FOUND') {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Parent entity not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Access to this entity is denied',
          details: [{ field: 'reason', issue: result.error.reason }],
          request_id: request.id,
        },
      });
    },
  );

  // Informational GET for discoverability: lets MCP clients list the
  // set of supported parent types and scan-status filter values
  // without consulting docs. Returns a static response.
  fastify.get(
    '/v1/attachments/_meta',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.attachment__meta.list')],
    },
    async (_request, reply) => {
      return reply.send({
        data: {
          supported_parent_types: SUPPORTED_PARENT_TYPES,
          supported_scan_statuses: SUPPORTED_SCAN_STATUSES,
          list_limit_default: DEFAULT_LIST_LIMIT,
          list_limit_max: MAX_LIST_LIMIT,
        },
      });
    },
  );
}
