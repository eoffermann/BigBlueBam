/**
 * Cross-product routes that bridge Blueprint and Bam:
 *   - POST /diagrams/:id/promote-to-tasks  → returns the structured
 *     plan (caller executes via existing Bam endpoints / MCP tools).
 *   - POST /diagrams/from-bam              → materializes a new diagram
 *     from a Bam project's tasks + parent links, ready to open.
 *   - POST /internal/sync-from-task        → invoked by apps/api when a
 *     task's title or description changes, to propagate the change into
 *     every linked blueprint_node. Auth via INTERNAL_SERVICE_SECRET.
 *
 * The promote endpoint deliberately doesn't create the tasks itself —
 * the caller (SPA or agent) owns that step so attribution stays on the
 * caller and the SPA can show progress. Mirrors the existing per-node
 * `promote-to-task` pattern.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publishBoltEvent } from '@bigbluebam/shared';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as diagramSvc from '../services/diagram.service.js';
import * as crossSvc from '../services/cross-product.service.js';
import { broadcastToDiagram } from '../lib/broadcast.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { env } from '../env.js';

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

const promoteSchema = z.object({
  project_id: z.string().uuid(),
  phase_id: z.string().uuid().nullable().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
  edge_direction: z.enum(['source-parent', 'target-parent', 'none']).optional(),
});

const generateSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  include_completed: z.boolean().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['organization', 'project', 'private']).optional(),
  auto_layout: z.boolean().optional(),
});

const syncFromTaskSchema = z.object({
  task_id: z.string().uuid(),
  title: z.string().max(500).optional(),
  description: z.string().nullable().optional(),
});

export default async function crossProductRoutes(fastify: FastifyInstance) {
  // ─── Promote graph → Bam tasks (returns the plan) ────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/diagrams/:id/promote-to-tasks',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = promoteSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        await diagramSvc.assertCanEdit(orgId, userId, request.params.id);
        const plan = await diagramSvc.planPromoteGraph(orgId, request.params.id, body);
        publishBoltEvent(
          'diagram.promoted_to_tasks',
          'blueprint',
          {
            'diagram.id': request.params.id,
            project_id: body.project_id,
            task_count: plan.tasks_to_create.length,
            link_count: plan.parent_links_to_create.length,
          },
          orgId,
          userId,
          'user',
        ).catch(() => {});
        return reply.send({ data: plan });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Generate diagram ← Bam tasks ────────────────────────────────────
  fastify.post(
    '/diagrams/from-bam',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = generateSchema.parse(request.body);
      const orgId = request.user!.org_id;
      const userId = request.user!.id;
      try {
        const result = await crossSvc.generateDiagramFromBam({
          org_id: orgId,
          user_id: userId,
          project_id: body.project_id,
          name: body.name,
          description: body.description,
          include_completed: body.include_completed,
          sprint_id: body.sprint_id,
          visibility: body.visibility,
          auto_layout: body.auto_layout,
        });
        publishBoltEvent(
          'diagram.generated',
          'blueprint',
          {
            'diagram.id': result.diagram_id,
            'source.project_id': body.project_id,
            source: 'bam',
            node_count: result.node_count,
            edge_count: result.edge_count,
          },
          orgId,
          userId,
          'user',
        ).catch(() => {});
        return reply.status(201).send({ data: result });
      } catch (err) {
        const mapped = mapErr(err, request.id);
        if (mapped) return reply.status(mapped.status).send(mapped.body);
        throw err;
      }
    },
  );

  // ─── Internal: sync a task update into every linked node ────────────
  //
  // Called by the bam api when a task with a linked blueprint_node has
  // its title or description changed. Auth is INTERNAL_SERVICE_SECRET
  // ONLY — no user session involved, which is correct because the
  // calling api has already authenticated the original user.
  fastify.post(
    '/internal/sync-from-task',
    async (request, reply) => {
      // Accept either x-internal-secret or x-internal-token to match the
      // bolt-api and helpdesk-api conventions exactly.
      const secretHeader = request.headers['x-internal-secret'];
      const tokenHeader = request.headers['x-internal-token'];
      const provided =
        (Array.isArray(secretHeader) ? secretHeader[0] : secretHeader) ??
        (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader);
      if (
        !env.INTERNAL_SERVICE_SECRET ||
        typeof provided !== 'string' ||
        provided !== env.INTERNAL_SERVICE_SECRET
      ) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid internal service token',
            details: [],
            request_id: request.id,
          },
        });
      }
      const body = syncFromTaskSchema.parse(request.body);
      const result = await crossSvc.applyTaskSyncToNodes(
        body.task_id,
        { title: body.title, description: body.description },
        {
          // Live broadcast each affected diagram so any open Blueprint
          // SPA picks up the synced change without manual refetch. The
          // raw write bypassed the updateNode service that fires the
          // outbound sync, so the broadcast can't bounce back to Bam.
          broadcast: async (diagramId, evt) => {
            await broadcastToDiagram(fastify.redis, diagramId, {
              type: 'blueprint.node.updated',
              diagram_id: diagramId,
              node_id: evt.node_id,
              changes: evt.changes,
            });
          },
        },
      );
      return reply.send({ data: result });
    },
  );
}
