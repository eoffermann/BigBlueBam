import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBoardAccess, requireBoardEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as linkService from '../services/link.service.js';
import { publishBoltEvent, buildBoardEventPayload } from '../lib/bolt-events.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const promoteSchema = z.object({
  element_ids: z.array(z.string().uuid()).min(1).max(100),
  project_id: z.string().uuid(),
  phase_id: z.string().uuid().optional(),
});

export default async function linkRoutes(fastify: FastifyInstance) {
  // POST /boards/:id/elements/promote - Batch promote stickies to Bam tasks
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/elements/promote',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_element.promote'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = promoteSchema.parse(request.body);
      const boardId = (request as any).board.id as string;
      const results = await linkService.promoteElements(
        boardId,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      const successfulTaskIds = results
        .map((r) => r.task_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (successfulTaskIds.length > 0) {
        try {
          const payload = await buildBoardEventPayload(
            boardId,
            request.user!.org_id,
            request.user!.id,
            {
              promoted_element_ids: data.element_ids,
              project_id: data.project_id,
              phase_id: data.phase_id ?? null,
            },
          );
          payload['board.element_count'] = successfulTaskIds.length;
          payload['board.task_ids'] = successfulTaskIds;
          payload['board.promoted_by'] = request.user!.id;
          payload['board.promoted_at'] = new Date().toISOString();
          publishBoltEvent(
            'board.elements_promoted',
            'board',
            payload,
            request.user!.org_id,
            request.user!.id,
            'user',
          );
        } catch {
          // Enrichment failure must never block the promotion response.
        }
      }
      return reply.status(201).send({ data: results });
    },
  );

  // GET /boards/:id/links - List element-task links
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/links',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_link.get')] },
    async (request, reply) => {
      const links = await linkService.getLinks((request as any).board.id);
      return reply.send({ data: links });
    },
  );

  // DELETE /links/:linkId - Delete a link
  fastify.delete<{ Params: { linkId: string } }>(
    '/links/:linkId',
    { preHandler: [requireAuth, shadowOnly('board.link.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const { linkId } = request.params;
      if (!linkId || !UUID_REGEX.test(linkId)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid link id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      await linkService.deleteLink(linkId, request.user!.org_id);
      return reply.status(204).send();
    },
  );
}
