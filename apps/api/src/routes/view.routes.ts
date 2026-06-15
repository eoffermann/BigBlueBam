import type { FastifyInstance } from 'fastify';
import { eq, and, or, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { savedViews } from '../db/schema/saved-views.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function viewRoutes(fastify: FastifyInstance) {
  // ── GET /projects/:id/views ───────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/views',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_view.get')] },
    async (request, reply) => {
      const userId = request.user!.id;
      const projectId = request.params.id;

      // Return user's own views + shared views in this project
      const result = await db
        .select()
        .from(savedViews)
        .where(
          and(
            eq(savedViews.project_id, projectId),
            or(
              eq(savedViews.user_id, userId),
              eq(savedViews.is_shared, true),
            ),
          ),
        )
        .orderBy(asc(savedViews.created_at));

      return reply.send({ data: result });
    },
  );

  // ── POST /projects/:id/views ──────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/views',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_view.create'), requireScope('read_write')] },
    async (request, reply) => {
      const bodySchema = z.object({
        name: z.string().min(1).max(255),
        filters: z.record(z.unknown()).optional().default({}),
        sort: z.string().max(100).optional(),
        view_type: z.enum(['board', 'list', 'timeline', 'calendar', 'workload']).optional().default('board'),
        swimlane: z.string().max(50).optional(),
        is_shared: z.boolean().optional().default(false),
      });

      const data = bodySchema.parse(request.body);

      const [view] = await db
        .insert(savedViews)
        .values({
          project_id: request.params.id,
          user_id: request.user!.id,
          name: data.name,
          filters: data.filters,
          sort: data.sort ?? null,
          view_type: data.view_type,
          swimlane: data.swimlane ?? null,
          is_shared: data.is_shared,
        })
        .returning();

      return reply.status(201).send({ data: view });
    },
  );

  // ── PATCH /views/:id ──────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>(
    '/views/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.view.update'), requireScope('read_write'), requireProjectAccessForEntity('saved_view')] },
    async (request, reply) => {
      const bodySchema = z.object({
        name: z.string().min(1).max(255).optional(),
        filters: z.record(z.unknown()).optional(),
        sort: z.string().max(100).nullable().optional(),
        view_type: z.enum(['board', 'list', 'timeline', 'calendar', 'workload']).optional(),
        swimlane: z.string().max(50).nullable().optional(),
        is_shared: z.boolean().optional(),
      });

      const data = bodySchema.parse(request.body);

      // Check ownership
      const [existing] = await db
        .select()
        .from(savedViews)
        .where(eq(savedViews.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'View not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.user_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only edit your own views',
            details: [],
            request_id: request.id,
          },
        });
      }

      const updateValues: Record<string, unknown> = {
        updated_at: new Date(),
      };

      if (data.name !== undefined) updateValues.name = data.name;
      if (data.filters !== undefined) updateValues.filters = data.filters;
      if (data.sort !== undefined) updateValues.sort = data.sort;
      if (data.view_type !== undefined) updateValues.view_type = data.view_type;
      if (data.swimlane !== undefined) updateValues.swimlane = data.swimlane;
      if (data.is_shared !== undefined) updateValues.is_shared = data.is_shared;

      const [view] = await db
        .update(savedViews)
        .set(updateValues)
        .where(eq(savedViews.id, request.params.id))
        .returning();

      return reply.send({ data: view });
    },
  );

  // ── DELETE /views/:id ─────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/views/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.view.delete'), requireScope('read_write'), requireProjectAccessForEntity('saved_view')] },
    async (request, reply) => {
      const [existing] = await db
        .select()
        .from(savedViews)
        .where(eq(savedViews.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'View not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (existing.user_id !== request.user!.id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You can only delete your own views',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.delete(savedViews).where(eq(savedViews.id, request.params.id));

      return reply.send({ data: { success: true } });
    },
  );
}
