import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publishBoltEvent } from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as svc from '../services/edge.service.js';
import * as diagramSvc from '../services/diagram.service.js';
import { broadcastToDiagram } from '../lib/broadcast.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../lib/errors.js';

function mapErr(err: unknown, requestId: string) {
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: { code: err.code, message: err.message, details: [], request_id: requestId } } };
  }
  if (err instanceof ForbiddenError) {
    return { status: 403, body: { error: { code: err.code, message: err.message, details: [], request_id: requestId } } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: { code: err.code, message: err.message, details: err.details, request_id: requestId } } };
  }
  return null;
}

const createEdgeSchema = z.object({
  source_node_id: z.string().uuid(),
  target_node_id: z.string().uuid(),
  source_handle: z.string().max(64).nullable().optional(),
  target_handle: z.string().max(64).nullable().optional(),
  kind: z.string().max(32).optional(),
  label: z.string().max(2000).nullable().optional(),
  marker_start: z.string().max(16).optional(),
  marker_end: z.string().max(16).optional(),
  style: z.record(z.unknown()).optional(),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

const updateEdgeSchema = z.object({
  source_handle: z.string().max(64).nullable().optional(),
  target_handle: z.string().max(64).nullable().optional(),
  kind: z.string().max(32).optional(),
  label: z.string().max(2000).nullable().optional(),
  marker_start: z.string().max(16).optional(),
  marker_end: z.string().max(16).optional(),
  style: z.record(z.unknown()).optional(),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
});

export default async function edgeRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/edges',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = createEdgeSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.createEdge(request.params.id, body);
        publishBoltEvent(
          'edge.created',
          'blueprint',
          { 'diagram.id': request.params.id, 'edge.id': row.id, 'edge.kind': row.kind },
          orgId,
          userId,
          'user',
        ).catch(() => {});
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.edge.created',
          diagram_id: request.params.id,
          edge: row,
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { id: string; edgeId: string } }>(
    '/diagrams/:id/edges/:edgeId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateEdgeSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.updateEdge(request.params.id, request.params.edgeId, body);
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.edge.updated',
          diagram_id: request.params.id,
          edge_id: row.id,
          changes: body,
          edge: row,
        });
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string; edgeId: string } }>(
    '/diagrams/:id/edges/:edgeId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.deleteEdge(request.params.id, request.params.edgeId);
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.edge.deleted',
          diagram_id: request.params.id,
          edge_id: row.id,
        });
        return reply.send({ data: { id: row.id, deleted: true } });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );
}
