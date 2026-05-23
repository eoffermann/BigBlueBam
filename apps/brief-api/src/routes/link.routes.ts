import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess, requireDocumentEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { db } from '../db/index.js';
import { briefDocuments } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import * as linkService from '../services/link.service.js';

const createTaskLinkSchema = z.object({
  task_id: z.string().uuid(),
  link_type: z.enum(['reference', 'spec', 'notes', 'postmortem']).default('reference'),
});

const createBeaconLinkSchema = z.object({
  beacon_id: z.string().uuid(),
  link_type: z.enum(['reference', 'source', 'related']).default('reference'),
});

export default async function linkRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/links — List all links for a document
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/links',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_link.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const links = await linkService.getLinks(doc.id);
      return reply.send({ data: links });
    },
  );

  // POST /documents/:id/links/task — Create a task link
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/links/task',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), fastify.requireCan('brief.document_link_task.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const { task_id, link_type } = createTaskLinkSchema.parse(request.body);

      const link = await linkService.createTaskLink(
        request.params.id,
        task_id,
        link_type,
        request.user!.id,
        request.user!.org_id,
      );

      if (!link) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'Link already exists or referenced entity not found in this organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.status(201).send({ data: link });
    },
  );

  // POST /documents/:id/links/beacon — Create a beacon link
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/links/beacon',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), fastify.requireCan('brief.document_link_beacon.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const { beacon_id, link_type } = createBeaconLinkSchema.parse(request.body);

      const link = await linkService.createBeaconLink(
        request.params.id,
        beacon_id,
        link_type,
        request.user!.id,
        request.user!.org_id,
      );

      if (!link) {
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'Link already exists or referenced entity not found in this organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.status(201).send({ data: link });
    },
  );

  // DELETE /links/:linkId — Delete a link
  fastify.delete<{ Params: { linkId: string } }>(
    '/links/:linkId',
    { preHandler: [requireAuth, shadowOnly('brief.link.delete'), requireScope('read_write')] },
    async (request, reply) => {
      // We need a document_id context — get it from query param
      const query = z.object({ document_id: z.string().uuid() }).parse(request.query);

      // Verify the user has access to the document and it belongs to their org
      const [doc] = await db
        .select({ org_id: briefDocuments.org_id, created_by: briefDocuments.created_by })
        .from(briefDocuments)
        .where(
          and(
            eq(briefDocuments.id, query.document_id),
            eq(briefDocuments.org_id, request.user!.org_id),
          ),
        )
        .limit(1);

      if (!doc) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Document not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const deleted = await linkService.deleteLink(
        request.params.linkId,
        query.document_id,
      );

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: deleted });
    },
  );
}
