import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publishBoltEvent } from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as svc from '../services/diagram.service.js';
import * as nodeSvc from '../services/node.service.js';
import * as edgeSvc from '../services/edge.service.js';
import * as layoutSvc from '../services/layout.service.js';
import * as exportSvc from '../services/export.service.js';
import * as importSvc from '../services/import.service.js';
import { broadcastToDiagram } from '../lib/broadcast.js';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import { env } from '../env.js';

const createDiagramSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  project_id: z.string().uuid().nullable().optional(),
  diagram_type: z.string().max(32).optional(),
  layout_algorithm: z.string().max(32).optional(),
  visibility: z.enum(['organization', 'project', 'private']).optional(),
  layout_options: z.record(z.unknown()).optional(),
  canvas_settings: z.record(z.unknown()).optional(),
  template_id: z.string().uuid().optional(),
});

const updateDiagramSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  diagram_type: z.string().max(32).optional(),
  layout_algorithm: z.string().max(32).optional(),
  visibility: z.enum(['organization', 'project', 'private']).optional(),
  layout_options: z.record(z.unknown()).optional(),
  canvas_settings: z.record(z.unknown()).optional(),
});

function mapDomainError(err: unknown, requestId: string) {
  if (err instanceof NotFoundError) {
    return {
      status: 404,
      body: { error: { code: err.code, message: err.message, details: [], request_id: requestId } },
    };
  }
  if (err instanceof ForbiddenError) {
    return {
      status: 403,
      body: { error: { code: err.code, message: err.message, details: [], request_id: requestId } },
    };
  }
  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: { error: { code: err.code, message: err.message, details: err.details, request_id: requestId } },
    };
  }
  if (err instanceof ConflictError) {
    return {
      status: 409,
      body: { error: { code: err.code, message: err.message, details: [], request_id: requestId } },
    };
  }
  return null;
}

function emitBolt(eventType: string, payload: Record<string, unknown>, orgId: string, userId: string) {
  publishBoltEvent(eventType, 'blueprint', payload, orgId, userId, 'user').catch(() => {});
}

export default async function diagramRoutes(fastify: FastifyInstance) {
  // ─── List + Create ──────────────────────────────────────────────────
  fastify.get('/diagrams', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = request.query as Record<string, string>;
    const rows = await svc.listDiagrams(request.user!.org_id, request.user!.id, {
      project_id: query.project_id,
      diagram_type: query.diagram_type,
      starred_by: query.starred === 'true' ? request.user!.id : undefined,
      include_archived: query.include_archived === 'true',
    });
    return reply.send({ data: rows });
  });

  fastify.post(
    '/diagrams',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = createDiagramSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        const row = await svc.createDiagram(orgId, userId, body);
        emitBolt(
          'diagram.created',
          { 'diagram.id': row.id, 'diagram.name': row.name, 'diagram.diagram_type': row.diagram_type },
          orgId,
          userId,
        );
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Per-diagram ────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const row = await svc.assertCanRead(
          request.user!.org_id,
          request.user!.id,
          request.params.id,
        );
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/diagrams/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateDiagramSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await svc.assertCanEdit(orgId, userId, request.params.id);
        const row = await svc.updateDiagram(orgId, request.params.id, body);
        emitBolt('diagram.updated', { 'diagram.id': row.id, changed_fields: Object.keys(body) }, orgId, userId);
        await broadcastToDiagram(fastify.redis, row.id, {
          type: 'blueprint.diagram.updated',
          diagram_id: row.id,
          changes: body,
        });
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/archive',
    { preHandler: [requireAuth, requireScope('admin')] },
    async (request, reply) => {
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        const row = await svc.archiveDiagram(orgId, request.params.id);
        emitBolt('diagram.archived', { 'diagram.id': row.id }, orgId, userId);
        return reply.send({ data: { id: row.id, is_archived: true } });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Graph payload ──────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/graph',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        await svc.assertCanRead(request.user!.org_id, request.user!.id, request.params.id);
        const graph = await svc.getDiagramGraph(request.user!.org_id, request.params.id);
        return reply.send({ data: graph });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Nodes (read) ───────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/nodes',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        await svc.assertCanRead(request.user!.org_id, request.user!.id, request.params.id);
        const nodes = await nodeSvc.listNodes(request.params.id);
        return reply.send({ data: nodes });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Edges (read) ───────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/edges',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        await svc.assertCanRead(request.user!.org_id, request.user!.id, request.params.id);
        const edges = await edgeSvc.listEdges(request.params.id);
        return reply.send({ data: edges });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Layout ─────────────────────────────────────────────────────────
  const layoutSchema = z.object({
    algorithm: z.string().max(32).optional(),
    direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']).optional(),
    spacing: z.number().int().positive().max(500).optional(),
    node_node_spacing: z.number().int().positive().max(500).optional(),
    layer_spacing: z.number().int().positive().max(500).optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/layout',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = layoutSchema.parse(request.body ?? {});
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await svc.assertCanEdit(orgId, userId, request.params.id);
        const nodes = await nodeSvc.listNodes(request.params.id);
        if (nodes.length > env.LAYOUT_INPROCESS_NODE_LIMIT) {
          return reply.status(202).send({
            data: {
              status: 'queued',
              message: `Layout queued for worker (graph has ${nodes.length} nodes, limit ${env.LAYOUT_INPROCESS_NODE_LIMIT}).`,
            },
          });
        }
        const result = await layoutSvc.applyLayout(request.params.id, body);
        emitBolt(
          'layout.applied',
          {
            'diagram.id': request.params.id,
            layout_algorithm: result.algorithm,
            node_count: result.positions.length,
          },
          orgId,
          userId,
        );
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.layout.applied',
          diagram_id: request.params.id,
          positions: result.positions,
        });
        return reply.send({ data: result });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Generate (build from a structured node/edge spec) ──────────────
  const generateSchema = z.object({
    nodes: z
      .array(
        z.object({
          ref: z.string().min(1).max(64),
          label: z.string().max(500),
          shape: z.string().max(32).optional(),
          parent_ref: z.string().max(64).nullable().optional(),
          ref_entity_type: z.string().max(32).nullable().optional(),
          ref_entity_id: z.string().uuid().nullable().optional(),
        }),
      )
      .min(1)
      .max(500),
    edges: z
      .array(
        z.object({
          source_ref: z.string().min(1).max(64),
          target_ref: z.string().min(1).max(64),
          label: z.string().max(500).optional(),
          kind: z.string().max(32).optional(),
        }),
      )
      .max(2000)
      .optional(),
    auto_layout: z.boolean().optional(),
    replace: z.boolean().optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/generate',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = generateSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await svc.assertCanEdit(orgId, userId, request.params.id);
        if (body.replace) {
          // Drop everything first via the import-replace utility
          await importSvc.importMermaid(request.params.id, '', { replace: true });
        }
        // Materialize nodes, building ref → uuid map.
        const refMap = new Map<string, string>();
        for (const n of body.nodes) {
          const row = await nodeSvc.createNode(request.params.id, {
            label: n.label,
            shape: n.shape ?? 'rounded',
            ref_entity_type: n.ref_entity_type ?? null,
            ref_entity_id: n.ref_entity_id ?? null,
          });
          refMap.set(n.ref, row.id);
        }
        // Resolve parent_ref now that every node has an id
        for (const n of body.nodes) {
          if (n.parent_ref && refMap.has(n.parent_ref)) {
            await nodeSvc.updateNode(request.params.id, refMap.get(n.ref)!, {
              parent_node_id: refMap.get(n.parent_ref)!,
            });
          }
        }
        for (const e of body.edges ?? []) {
          const src = refMap.get(e.source_ref);
          const tgt = refMap.get(e.target_ref);
          if (src && tgt) {
            await edgeSvc.createEdge(request.params.id, {
              source_node_id: src,
              target_node_id: tgt,
              label: e.label ?? null,
              kind: e.kind,
            });
          }
        }
        let layoutResult = null;
        if (body.auto_layout !== false) {
          layoutResult = await layoutSvc.applyLayout(request.params.id, {});
        }
        const graph = await svc.getDiagramGraph(orgId, request.params.id);
        emitBolt(
          'diagram.generated',
          { 'diagram.id': request.params.id, node_count: body.nodes.length },
          orgId,
          userId,
        );
        return reply.status(201).send({ data: { graph, layout: layoutResult } });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Import / Export ────────────────────────────────────────────────
  const importSchema = z.object({
    format: z.enum(['mermaid']),
    source: z.string().min(1).max(200000),
    replace: z.boolean().optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/import',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = importSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await svc.assertCanEdit(orgId, userId, request.params.id);
        const result = await importSvc.importMermaid(request.params.id, body.source, {
          replace: body.replace,
        });
        emitBolt('diagram.imported', { 'diagram.id': request.params.id, ...result }, orgId, userId);
        return reply.send({ data: result });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/diagrams/:id/export',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const format = (request.query.format ?? 'json') as 'json' | 'mermaid' | 'svg' | 'png';
      try {
        await svc.assertCanRead(request.user!.org_id, request.user!.id, request.params.id);
        const result = await exportSvc.exportDiagram(request.params.id, format);
        reply.header('Content-Type', result.content_type);
        return reply.send(result.body);
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Versions ───────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/versions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await svc.listVersions(request.user!.org_id, request.params.id);
        return reply.send({ data: rows });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/versions',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = z.object({ label: z.string().max(200).nullable().optional() }).parse(request.body ?? {});
      try {
        const row = await svc.snapshotVersion(
          request.user!.org_id,
          request.params.id,
          request.user!.id,
          body.label ?? null,
        );
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string; n: string } }>(
    '/diagrams/:id/versions/:n/restore',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const versionNumber = Number.parseInt(request.params.n, 10);
      if (!Number.isFinite(versionNumber)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'version number must be an integer',
            details: [],
            request_id: request.id,
          },
        });
      }
      try {
        const graph = await svc.restoreVersion(
          request.user!.org_id,
          request.params.id,
          versionNumber,
        );
        return reply.send({ data: graph });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Stars ──────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/star',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        await svc.starDiagram(request.user!.org_id, request.user!.id, request.params.id);
        return reply.send({ data: { starred: true } });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/diagrams/:id/star',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        await svc.unstarDiagram(request.user!.org_id, request.user!.id, request.params.id);
        return reply.send({ data: { starred: false } });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Collaborators ──────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/collaborators',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await svc.listCollaborators(request.user!.org_id, request.params.id);
        return reply.send({ data: rows });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  const addCollabSchema = z.object({
    user_id: z.string().uuid(),
    role: z.enum(['owner', 'editor', 'commenter', 'viewer']).optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/collaborators',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = addCollabSchema.parse(request.body);
      try {
        const row = await svc.addCollaborator(
          request.user!.org_id,
          request.params.id,
          body.user_id,
          body.role ?? 'editor',
        );
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/diagrams/:id/collaborators/:userId',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      try {
        await svc.removeCollaborator(
          request.user!.org_id,
          request.params.id,
          request.params.userId,
        );
        return reply.send({ data: { removed: true } });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Comments ───────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/diagrams/:id/comments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await svc.listComments(request.user!.org_id, request.params.id);
        return reply.send({ data: rows });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  const addCommentSchema = z.object({
    body: z.string().min(1).max(10000),
    body_plain: z.string().max(10000).nullable().optional(),
    node_id: z.string().uuid().nullable().optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/comments',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const body = addCommentSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        const row = await svc.addComment(
          orgId,
          request.params.id,
          userId,
          body.body,
          body.body_plain ?? null,
          body.node_id ?? null,
        );
        await broadcastToDiagram(fastify.redis, request.params.id, {
          type: 'blueprint.comment.created',
          diagram_id: request.params.id,
          comment: row,
        });
        return reply.status(201).send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  const patchCommentSchema = z.object({
    body: z.string().min(1).max(10000).optional(),
    body_plain: z.string().max(10000).nullable().optional(),
    resolved: z.boolean().optional(),
  });

  fastify.patch<{ Params: { id: string; cid: string } }>(
    '/diagrams/:id/comments/:cid',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const body = patchCommentSchema.parse(request.body);
      try {
        const row = await svc.updateComment(
          request.user!.org_id,
          request.params.id,
          request.params.cid,
          body,
        );
        return reply.send({ data: row });
      } catch (err) {
        const mapped = mapDomainError(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );
}
