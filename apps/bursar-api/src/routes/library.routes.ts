import type { FastifyInstance } from 'fastify';
import { bursarLibraryCreateSchema, bursarLibraryUpdateSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import * as library from '../services/library.service.js';

// Org scope-library CRUD routes (spec 11, M8). Reads see globals + org rows; writes operate ONLY on
// the org's own rows and REJECT any write aimed at a global built-in (LIBRARY_GLOBAL_READONLY -> 400).
export default async function libraryRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get('/library', { preHandler: [requireAuth, can('bursar.settings.read')] }, async (request) => {
    return library.listLibrary(viewerOf(request));
  });

  fastify.post('/library', { preHandler: [requireAuth, can('bursar.library.write')] }, async (request, reply) => {
    const parsed = bursarLibraryCreateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      const result = await library.createLibraryEntry(viewerOf(request), parsed.data);
      reply.status(201);
      return result;
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.patch('/library/:id', { preHandler: [requireAuth, can('bursar.library.write')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = bursarLibraryUpdateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(request, reply, parsed.error);
    try {
      return await library.updateLibraryEntry(viewerOf(request), id, parsed.data);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });

  fastify.delete('/library/:id', { preHandler: [requireAuth, can('bursar.library.write')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await library.deleteLibraryEntry(viewerOf(request), id);
    } catch (err) {
      if (mapServiceError(request, reply, err)) return reply;
      throw err;
    }
  });
}
