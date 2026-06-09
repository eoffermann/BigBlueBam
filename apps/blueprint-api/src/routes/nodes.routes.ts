import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publishBoltEvent } from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as svc from '../services/node.service.js';
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

const createNodeSchema = z.object({
  shape: z.string().max(32).optional(),
  label: z.string().max(2000).optional(),
  description: z.string().max(10000).optional(),
  parent_node_id: z.string().uuid().nullable().optional(),
  position_x: z.number().optional(),
  position_y: z.number().optional(),
  width: z.number().positive().max(5000).optional(),
  height: z.number().positive().max(5000).optional(),
  z_index: z.number().int().optional(),
  pinned: z.boolean().optional(),
  style: z.record(z.unknown()).optional(),
  data: z.record(z.unknown()).optional(),
  ref_entity_type: z.string().max(32).nullable().optional(),
  ref_entity_id: z.string().uuid().nullable().optional(),
});

const updateNodeSchema = z.object({
  shape: z.string().max(32).optional(),
  label: z.string().max(2000).optional(),
  description: z.string().max(10000).nullable().optional(),
  parent_node_id: z.string().uuid().nullable().optional(),
  width: z.number().positive().max(5000).optional(),
  height: z.number().positive().max(5000).optional(),
  z_index: z.number().int().optional(),
  pinned: z.boolean().optional(),
  style: z.record(z.unknown()).optional(),
  data: z.record(z.unknown()).optional(),
  ref_entity_type: z.string().max(32).nullable().optional(),
  ref_entity_id: z.string().uuid().nullable().optional(),
});

const moveNodeSchema = z.object({
  position_x: z.number(),
  position_y: z.number(),
  pinned: z.boolean().optional(),
});

const promoteSchema = z.object({
  project_id: z.string().uuid(),
  phase_id: z.string().uuid().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
  title: z.string().max(500).optional(),
});

const linkEntitySchema = z.object({
  ref_entity_type: z.string().min(1).max(32),
  ref_entity_id: z.string().uuid(),
});

export default async function nodeRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/nodes',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = createNodeSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.createNode(request.params.id, body);
        publishBoltEvent(
          'node.created',
          'blueprint',
          { 'diagram.id': request.params.id, 'node.id': row.id, 'node.shape': row.shape },
          orgId,
          userId,
          'user',
        ).catch(() => {});
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.node.created',
          diagram_id: request.params.id,
          node: row,
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateNodeSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.updateNode(request.params.id, request.params.nodeId, body);
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.node.updated',
          diagram_id: request.params.id,
          node_id: row.id,
          changes: body,
          node: row,
        });
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId/move',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = moveNodeSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.moveNode(
          request.params.id,
          request.params.nodeId,
          body.position_x,
          body.position_y,
          body.pinned,
        );
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.node.moved',
          diagram_id: request.params.id,
          node_id: row.id,
          position_x: row.position_x,
          position_y: row.position_y,
        });
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  const duplicateSchema = z.object({
    offset_x: z.number().min(-2000).max(2000).optional(),
    offset_y: z.number().min(-2000).max(2000).optional(),
  });

  fastify.post<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId/duplicate',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = duplicateSchema.parse(request.body ?? {});
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.duplicateNode(
          request.params.id,
          request.params.nodeId,
          body.offset_x,
          body.offset_y,
        );
        publishBoltEvent(
          'node.created',
          'blueprint',
          {
            'diagram.id': request.params.id,
            'node.id': row.id,
            'node.shape': row.shape,
            duplicate_of: request.params.nodeId,
          },
          orgId,
          userId,
          'user',
        ).catch(() => {});
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.node.created',
          diagram_id: request.params.id,
          node: row,
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const result = await svc.deleteNode(request.params.id, request.params.nodeId);
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.node.deleted',
          diagram_id: request.params.id,
          node_id: result.id,
          cascaded_edge_ids: result.cascaded_edge_ids,
        });
        return reply.send({ data: { id: result.id, deleted: true } });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Cross-product: link / promote ──────────────────────────────────
  fastify.post<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId/link-entity',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = linkEntitySchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.updateNode(request.params.id, request.params.nodeId, {
          ref_entity_type: body.ref_entity_type,
          ref_entity_id: body.ref_entity_id,
        });
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string; nodeId: string } }>(
    '/diagrams/:id/nodes/:nodeId/promote-to-task',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = promoteSchema.parse(request.body);
      // The actual task creation lives in the Bam api. Blueprint records
      // the intent here; the route returns the structured payload the
      // caller can POST to /b3/api/projects/:id/tasks. A future commit
      // will wire this server-side via INTERNAL_SERVICE_SECRET. For MVP
      // the SPA already has a session cookie so it can do the second hop.
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const nodes = await svc.listNodes(request.params.id);
        const node = nodes.find((n) => n.id === request.params.nodeId);
        if (!node) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Node not found', details: [], request_id: request.id },
          });
        }
        return reply.send({
          data: {
            task_payload: {
              project_id: body.project_id,
              title: body.title ?? node.label,
              description: node.description ?? '',
              phase_id: body.phase_id,
              sprint_id: body.sprint_id ?? null,
            },
            node: {
              id: node.id,
              suggested_link: {
                ref_entity_type: 'bam.task',
              },
            },
          },
        });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );
}
