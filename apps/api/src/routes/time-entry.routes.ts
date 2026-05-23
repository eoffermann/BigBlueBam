import type { FastifyInstance } from 'fastify';
import { eq, and, gte, lte, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { timeEntries } from '../db/schema/time-entries.js';
import { tasks } from '../db/schema/tasks.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function timeEntryRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/time-entries',
    { preHandler: [requireAuth, fastify.requireCan('bam.task_time_entry.create'), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const schema = z.object({
        minutes: z.number().int().positive(),
        date: z.string(),
        description: z.string().optional(),
      });
      const data = schema.parse(request.body);

      const [entry] = await db
        .insert(timeEntries)
        .values({
          task_id: request.params.id,
          user_id: request.user!.id,
          minutes: data.minutes,
          date: data.date,
          description: data.description ?? null,
        })
        .returning();

      // Increment time_logged_minutes on task
      await db
        .update(tasks)
        .set({
          time_logged_minutes: sql`${tasks.time_logged_minutes} + ${data.minutes}`,
          updated_at: new Date(),
        })
        .where(eq(tasks.id, request.params.id));

      return reply.status(201).send({ data: entry });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/time-entries',
    { preHandler: [requireAuth, requireProjectAccessForEntity('task'), shadowOnly('bam.task_time_entry.get')] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.task_id, request.params.id))
        .orderBy(asc(timeEntries.date));

      return reply.send({ data: result });
    },
  );

  fastify.get<{
    Querystring: { start_date?: string; end_date?: string };
  }>(
    '/me/time-entries',
    { preHandler: [requireAuth, shadowOnly('bam.me_time_entry.list')] },
    async (request, reply) => {
      const conditions = [eq(timeEntries.user_id, request.user!.id)];

      if (request.query.start_date) {
        conditions.push(gte(timeEntries.date, request.query.start_date));
      }
      if (request.query.end_date) {
        conditions.push(lte(timeEntries.date, request.query.end_date));
      }

      const result = await db
        .select()
        .from(timeEntries)
        .where(and(...conditions))
        .orderBy(asc(timeEntries.date));

      return reply.send({ data: result });
    },
  );
}
