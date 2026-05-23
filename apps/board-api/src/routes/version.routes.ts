import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBoardAccess, requireBoardEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as versionService from '../services/version.service.js';

const createVersionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});

export default async function versionRoutes(fastify: FastifyInstance) {
  // GET /boards/:id/versions - List versions
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/versions',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_version.get')] },
    async (request, reply) => {
      const versions = await versionService.listVersions((request as any).board.id);
      return reply.send({ data: versions });
    },
  );

  // POST /boards/:id/versions - Create named snapshot
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/versions',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_version.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = createVersionSchema.parse(request.body);
      const version = await versionService.createVersion(
        (request as any).board.id,
        data.name,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: version });
    },
  );

  // POST /boards/:id/versions/:versionId/restore - Restore a version
  fastify.post<{ Params: { id: string; versionId: string } }>(
    '/boards/:id/versions/:versionId/restore',
    { preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_version.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const { versionId } = request.params;
      const board = await versionService.restoreVersion(
        (request as any).board.id,
        versionId,
        request.user!.id,
      );
      return reply.send({ data: board });
    },
  );
}
