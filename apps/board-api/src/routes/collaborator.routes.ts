import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBoardAccess, requireBoardEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { db } from '../db/index.js';
import { boardCollaborators } from '../db/schema/index.js';
import * as collaboratorService from '../services/collaborator.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERMISSIONS = ['view', 'edit'] as const;

const addCollaboratorSchema = z.object({
  user_id: z.string().uuid(),
  permission: z.enum(PERMISSIONS).optional().default('edit'),
});

const updateCollaboratorSchema = z.object({
  permission: z.enum(PERMISSIONS),
});

/**
 * Middleware that resolves a collaborator's board_id from the :collabId param
 * and injects it as params.id so requireBoardEditAccess() can load the board.
 */
async function resolveCollabBoard(request: FastifyRequest, reply: FastifyReply) {
  const { collabId } = request.params as { collabId: string };
  if (!collabId || !UUID_REGEX.test(collabId)) {
    return reply.status(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: 'Valid collaborator id is required',
        details: [],
        request_id: request.id,
      },
    });
  }

  const [collab] = await db
    .select({ board_id: boardCollaborators.board_id })
    .from(boardCollaborators)
    .where(eq(boardCollaborators.id, collabId))
    .limit(1);

  if (!collab) {
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Collaborator not found',
        details: [],
        request_id: request.id,
      },
    });
  }

  // Inject board id so requireBoardEditAccess() can find the board via params.id
  (request.params as any).id = collab.board_id;
}

export default async function collaboratorRoutes(fastify: FastifyInstance) {
  // GET /boards/:id/collaborators - List collaborators
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/collaborators',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_collaborator.get')] },
    async (request, reply) => {
      const collaborators = await collaboratorService.listCollaborators(
        (request as any).board.id,
      );
      return reply.send({ data: collaborators });
    },
  );

  // POST /boards/:id/collaborators - Add collaborator
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/collaborators',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_collaborator.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = addCollaboratorSchema.parse(request.body);
      const collab = await collaboratorService.addCollaborator(
        (request as any).board.id,
        data,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: collab });
    },
  );

  // PATCH /collaborators/:collabId - Update collaborator permission
  fastify.patch<{ Params: { collabId: string } }>(
    '/collaborators/:collabId',
    { preHandler: [requireAuth, resolveCollabBoard, requireBoardEditAccess(), shadowOnly('board.collaborator.update'), requireScope('read_write')] },
    async (request, reply) => {
      const { collabId } = request.params;
      const data = updateCollaboratorSchema.parse(request.body);
      const collab = await collaboratorService.updateCollaborator(
        collabId,
        data,
        request.user!.org_id,
      );
      return reply.send({ data: collab });
    },
  );

  // DELETE /collaborators/:collabId - Remove collaborator
  fastify.delete<{ Params: { collabId: string } }>(
    '/collaborators/:collabId',
    { preHandler: [requireAuth, resolveCollabBoard, requireBoardEditAccess(), shadowOnly('board.collaborator.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const { collabId } = request.params;
      await collaboratorService.deleteCollaborator(collabId, request.user!.org_id);
      return reply.status(204).send();
    },
  );
}
