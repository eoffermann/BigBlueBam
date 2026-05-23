import type { FastifyInstance } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { taskStates } from '../db/schema/task-states.js';
import { requireAuth } from '../plugins/auth.js';
import { requireProjectAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

export default async function taskStateRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/states',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_state.get')] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(taskStates)
        .where(eq(taskStates.project_id, request.params.id))
        .orderBy(asc(taskStates.position));

      return reply.send({ data: result });
    },
  );
}
