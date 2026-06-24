import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as folderService from '../services/folder.service.js';
import { NotFoundError } from '../services/folder.service.js';

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  project_id: z.string().uuid().nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
});

const updateFolderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  parent_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
});

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof Error && err.message.includes('own parent')) {
    return reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

export default async function folderRoutes(fastify: FastifyInstance) {
  // GET /folders — list folders (optionally by parent/project)
  fastify.get('/folders', { preHandler: [requireAuth] }, async (request, reply) => {
    const q = request.query as Record<string, string>;
    const folders = await folderService.listFolders(request.user!.org_id, {
      parent_id: q.parent_id === 'root' ? null : q.parent_id,
      project_id: q.project_id,
    });
    return reply.send({ data: folders });
  });

  // POST /folders — create a folder
  fastify.post(
    '/folders',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.folder.create')] },
    async (request, reply) => {
      const body = createFolderSchema.parse(request.body);
      try {
        const folder = await folderService.createFolder(body, request.user!.org_id, request.user!.id);
        return reply.status(201).send({ data: folder });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /folders/:id — get a single folder
  fastify.get<{ Params: { id: string } }>(
    '/folders/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const folder = await folderService.getFolder(request.params.id, request.user!.org_id);
        return reply.send({ data: folder });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /folders/:id — rename / move a folder
  fastify.patch<{ Params: { id: string } }>(
    '/folders/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.folder.update')] },
    async (request, reply) => {
      const body = updateFolderSchema.parse(request.body);
      try {
        const folder = await folderService.updateFolder(request.params.id, request.user!.org_id, body);
        return reply.send({ data: folder });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // DELETE /folders/:id — delete a folder
  fastify.delete<{ Params: { id: string } }>(
    '/folders/:id',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bin.folder.delete')] },
    async (request, reply) => {
      try {
        await folderService.deleteFolder(request.params.id, request.user!.org_id);
        return reply.send({ data: { deleted: true } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
