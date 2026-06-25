import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as annotationService from '../services/annotation.service.js';
import { NotFoundError, ConflictError } from '../services/errors.js';

const createAnnotationSchema = z.object({
  anchor: z.record(z.unknown()).optional(),
  body: z.string().min(1),
  thread_parent_id: z.string().uuid().nullable().optional(),
});

const resolveAnnotationSchema = z.object({
  resolved: z.boolean().optional(),
});

function sendError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof NotFoundError) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: err.message, details: [], request_id: request.id },
    });
  }
  if (err instanceof ConflictError) {
    return reply.status(409).send({
      error: { code: 'CONFLICT', message: err.message, details: [], request_id: request.id },
    });
  }
  throw err;
}

export default async function annotationRoutes(fastify: FastifyInstance) {
  // GET /versions/:id/annotations — list annotations on a version
  fastify.get<{ Params: { id: string } }>(
    '/versions/:id/annotations',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const q = request.query as Record<string, string>;
      try {
        const annotations = await annotationService.listAnnotations(
          request.params.id,
          request.user!.org_id,
          { include_resolved: q.include_resolved === 'true' },
        );
        return reply.send({ data: annotations });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /versions/:id/annotations — add an anchored annotation
  fastify.post<{ Params: { id: string } }>(
    '/versions/:id/annotations',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.annotation.create')] },
    async (request, reply) => {
      const body = createAnnotationSchema.parse(request.body);
      try {
        const annotation = await annotationService.createAnnotation(
          request.params.id,
          request.user!.org_id,
          request.user!.id,
          body,
        );
        return reply.status(201).send({ data: annotation });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /annotations/:id/resolve — mark an annotation resolved/unresolved
  fastify.post<{ Params: { id: string } }>(
    '/annotations/:id/resolve',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('bay.annotation_resolve.create')] },
    async (request, reply) => {
      const body = resolveAnnotationSchema.parse(request.body ?? {});
      try {
        const annotation = await annotationService.resolveAnnotation(
          request.params.id,
          request.user!.org_id,
          body.resolved ?? true,
        );
        return reply.send({ data: annotation });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
