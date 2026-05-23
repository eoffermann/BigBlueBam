import type { FastifyInstance } from 'fastify';
import { eq, and, asc, gte, sql } from 'drizzle-orm';
import { createPhaseSchema, updatePhaseSchema, reorderPhasesSchema } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { phases } from '../db/schema/phases.js';
import { tasks } from '../db/schema/tasks.js';
import { requireAuth } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function phaseRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/phases',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_phase.get')] },
    async (request, reply) => {
      const projectPhases = await db
        .select()
        .from(phases)
        .where(eq(phases.project_id, request.params.id))
        .orderBy(asc(phases.position));

      return reply.send({ data: projectPhases });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/phases',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_phase.create')] },
    async (request, reply) => {
      const data = createPhaseSchema.parse(request.body);

      // Shift existing phases at >= this position to make room
      await db
        .update(phases)
        .set({ position: sql`${phases.position} + 1` })
        .where(and(eq(phases.project_id, request.params.id), gte(phases.position, data.position)));

      const [phase] = await db
        .insert(phases)
        .values({
          project_id: request.params.id,
          name: data.name,
          description: data.description ?? null,
          color: data.color ?? null,
          position: data.position,
          wip_limit: data.wip_limit ?? null,
          is_start: data.is_start ?? false,
          is_terminal: data.is_terminal ?? false,
          auto_state_on_enter: data.auto_state_on_enter ?? null,
        })
        .returning();

      return reply.status(201).send({ data: phase });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/phases/:id',
    { preHandler: [requireAuth, requireProjectAccessForEntity('phase'), shadowOnly('bam.phase.update')] },
    async (request, reply) => {
      const data = updatePhaseSchema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.name !== undefined) updateValues.name = data.name;
      if (data.description !== undefined) updateValues.description = data.description;
      if (data.color !== undefined) updateValues.color = data.color;
      if (data.position !== undefined) updateValues.position = data.position;
      if (data.wip_limit !== undefined) updateValues.wip_limit = data.wip_limit;
      if (data.is_start !== undefined) updateValues.is_start = data.is_start;
      if (data.is_terminal !== undefined) updateValues.is_terminal = data.is_terminal;
      if (data.auto_state_on_enter !== undefined) updateValues.auto_state_on_enter = data.auto_state_on_enter;

      const [phase] = await db
        .update(phases)
        .set(updateValues)
        .where(eq(phases.id, request.params.id))
        .returning();

      if (!phase) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Phase not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: phase });
    },
  );

  fastify.delete<{ Params: { id: string }; Querystring: { migrate_to?: string } }>(
    '/phases/:id',
    { preHandler: [requireAuth, requireProjectAccessForEntity('phase'), fastify.requireCan('bam.phase.delete')] },
    async (request, reply) => {
      const migrateTo = request.query.migrate_to;

      // If migrate_to provided, move tasks to that phase
      if (migrateTo) {
        await db
          .update(tasks)
          .set({
            phase_id: migrateTo,
            updated_at: new Date(),
          })
          .where(eq(tasks.phase_id, request.params.id));
      }

      const [deleted] = await db
        .delete(phases)
        .where(eq(phases.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Phase not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/phases/reorder',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_phase_reorder.create')] },
    async (request, reply) => {
      const data = reorderPhasesSchema.parse(request.body);

      await db.transaction(async (tx) => {
        for (let i = 0; i < data.phase_ids.length; i++) {
          await tx
            .update(phases)
            .set({ position: i, updated_at: new Date() })
            .where(
              and(
                eq(phases.id, data.phase_ids[i]!),
                eq(phases.project_id, request.params.id),
              ),
            );
        }
      });

      const updated = await db
        .select()
        .from(phases)
        .where(eq(phases.project_id, request.params.id))
        .orderBy(asc(phases.position));

      return reply.send({ data: updated });
    },
  );
}
