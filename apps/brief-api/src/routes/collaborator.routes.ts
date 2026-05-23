import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess, requireDocumentEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as collaboratorService from '../services/collaborator.service.js';

const addCollaboratorSchema = z.object({
  user_id: z.string().uuid(),
  permission: z.enum(['view', 'comment', 'edit']).default('view'),
});

const updateCollaboratorSchema = z.object({
  permission: z.enum(['view', 'comment', 'edit']),
});

export default async function collaboratorRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/collaborators — List collaborators
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/collaborators',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_collaborator.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const collaborators = await collaboratorService.listCollaborators(doc.id);
      return reply.send({ data: collaborators });
    },
  );

  // POST /documents/:id/collaborators — Add a collaborator
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/collaborators',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_collaborator.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = addCollaboratorSchema.parse(request.body);
      const doc = (request as any).document;
      const collab = await collaboratorService.addCollaborator(doc.id, data, request.user!.org_id);
      return reply.status(201).send({ data: collab });
    },
  );

  // PATCH /collaborators/:collabId — Update collaborator permission
  fastify.patch<{ Params: { collabId: string } }>(
    '/collaborators/:collabId',
    { preHandler: [requireAuth, shadowOnly('brief.collaborator.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateCollaboratorSchema.parse(request.body);
      const collab = await collaboratorService.updateCollaborator(
        request.params.collabId,
        data,
        request.user!.org_id,
      );
      return reply.send({ data: collab });
    },
  );

  // DELETE /collaborators/:collabId — Remove a collaborator
  fastify.delete<{ Params: { collabId: string } }>(
    '/collaborators/:collabId',
    { preHandler: [requireAuth, shadowOnly('brief.collaborator.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const deleted = await collaboratorService.removeCollaborator(
        request.params.collabId,
        request.user!.org_id,
      );
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Collaborator not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: deleted });
    },
  );
}
