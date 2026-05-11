import type { FastifyInstance } from 'fastify';
import { eq, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { epics } from '../db/schema/epics.js';
import { tasks } from '../db/schema/tasks.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireProjectRole, requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

export default async function epicRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/epics',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const result = await db
        .select({
          id: epics.id,
          project_id: epics.project_id,
          name: epics.name,
          description: epics.description,
          color: epics.color,
          start_date: epics.start_date,
          target_date: epics.target_date,
          status: epics.status,
          created_at: epics.created_at,
          updated_at: epics.updated_at,
          task_count: sql<number>`count(${tasks.id})::int`,
        })
        .from(epics)
        .leftJoin(tasks, eq(tasks.epic_id, epics.id))
        .where(eq(epics.project_id, request.params.id))
        .groupBy(epics.id)
        .orderBy(asc(epics.created_at));

      return reply.send({ data: result });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/epics',
    { preHandler: [requireAuth, requireProjectRole('admin', 'member'), dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.project_epic.create' }), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255),
        description: z.string().optional(),
        color: z.string().max(7).optional(),
        start_date: z.string().optional(),
        target_date: z.string().optional(),
        status: z.enum(['open', 'in_progress', 'closed']).default('open'),
      });
      const data = schema.parse(request.body);

      const [epic] = await db
        .insert(epics)
        .values({
          project_id: request.params.id,
          name: data.name,
          description: data.description ?? null,
          color: data.color ?? null,
          start_date: data.start_date ?? null,
          target_date: data.target_date ?? null,
          status: data.status,
        })
        .returning();

      return reply.status(201).send({ data: epic });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/epics/:id',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.epic.update' }), requireScope('read_write'), requireProjectAccessForEntity('epic')] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().max(255).optional(),
        description: z.string().nullable().optional(),
        color: z.string().max(7).nullable().optional(),
        start_date: z.string().nullable().optional(),
        target_date: z.string().nullable().optional(),
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
      });
      const data = schema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.description !== undefined) updateValues.description = data.description;
      if (data.color !== undefined) updateValues.color = data.color;
      if (data.start_date !== undefined) updateValues.start_date = data.start_date;
      if (data.target_date !== undefined) updateValues.target_date = data.target_date;
      if (data.status !== undefined) updateValues.status = data.status;

      const [epic] = await db
        .update(epics)
        .set(updateValues)
        .where(eq(epics.id, request.params.id))
        .returning();

      if (!epic) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Epic not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: epic });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/epics/:id',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.epic.delete' }), requireScope('read_write'), requireProjectAccessForEntity('epic')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(epics)
        .where(eq(epics.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Epic not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
