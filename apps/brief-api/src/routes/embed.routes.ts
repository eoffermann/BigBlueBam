import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess, requireDocumentEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as embedService from '../services/embed.service.js';

const createEmbedSchema = z.object({
  file_name: z.string().min(1).max(500),
  file_size: z.number().int().min(1).max(100_000_000), // 100 MB max
  mime_type: z.string().min(1).max(255),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
});

export default async function embedRoutes(fastify: FastifyInstance) {
  // POST /documents/:id/embeds — Upload embed metadata
  // Note: actual file upload goes directly to MinIO/S3; this records the metadata
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/embeds',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_embed.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createEmbedSchema.parse(request.body);
      const doc = (request as any).document;
      const storageKey = embedService.generateStorageKey(doc.id, data.file_name);

      const embed = await embedService.createEmbed(
        doc.id,
        {
          file_name: data.file_name,
          file_size: data.file_size,
          mime_type: data.mime_type,
          storage_key: storageKey,
          width: data.width ?? null,
          height: data.height ?? null,
        },
        request.user!.id,
      );

      return reply.status(201).send({ data: { ...embed, storage_key: storageKey } });
    },
  );

  // GET /documents/:id/embeds — List embeds for a document
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/embeds',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_embed.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const embeds = await embedService.listEmbeds(doc.id);
      return reply.send({ data: embeds });
    },
  );

  // DELETE /embeds/:embedId — Delete an embed
  fastify.delete<{ Params: { embedId: string } }>(
    '/embeds/:embedId',
    { preHandler: [requireAuth, shadowOnly('brief.embed.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const deleted = await embedService.deleteEmbed(request.params.embedId, request.user!.org_id);
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Embed not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: deleted });
    },
  );
}
