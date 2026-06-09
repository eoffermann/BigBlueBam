/**
 * Internal sync endpoint called by blueprint-api when a blueprint_node
 * with ref_entity_type='bam.task' has its label or description changed.
 * Pushes the change into the canonical Bam task row via a RAW UPDATE
 * so the regular updateTask service-layer side-effects (broadcast,
 * Bolt event, activity log) don't fire here — that would loop the sync
 * back into blueprint via task.service.ts's outbound call.
 *
 * Auth: x-internal-secret or x-internal-token, validated against
 * INTERNAL_SERVICE_SECRET. Mirrors apps/api/src/routes/internal-llm.routes.ts.
 *
 * Mount prefix: /internal/sync-from-blueprint
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { env } from '../env.js';
import { broadcastToProject } from '../services/realtime.service.js';

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const syncSchema = z.object({
  task_id: z.string().uuid(),
  title: z.string().max(500).optional(),
  description: z.string().nullable().optional(),
});

export default async function internalBlueprintSyncRoutes(fastify: FastifyInstance) {
  fastify.post('/internal/sync-from-blueprint', async (request, reply) => {
    // Internal-auth guard — same pattern as internal-llm.routes.ts.
    const secretHeader = request.headers['x-internal-secret'];
    const tokenHeader = request.headers['x-internal-token'];
    const provided =
      (Array.isArray(secretHeader) ? secretHeader[0] : secretHeader) ??
      (Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader);

    if (!provided || typeof provided !== 'string') {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing internal service token',
          details: [],
          request_id: request.id,
        },
      });
    }
    const expected = env.INTERNAL_SERVICE_SECRET ?? '';
    if (!expected || !timingSafeStringEqual(provided, expected)) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid internal service token',
          details: [],
          request_id: request.id,
        },
      });
    }

    const parsed = syncSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid sync payload',
          details: parsed.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
          request_id: request.id,
        },
      });
    }

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.title !== undefined) update.title = parsed.data.title;
    if (parsed.data.description !== undefined) update.description = parsed.data.description;

    // Skip if nothing changes from the canonical row — keeps the loop
    // guard tight even when the sync runs twice in quick succession.
    const [current] = await db
      .select({ title: tasks.title, description: tasks.description })
      .from(tasks)
      .where(eq(tasks.id, parsed.data.task_id))
      .limit(1);
    if (!current) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Task not found',
          details: [],
          request_id: request.id,
        },
      });
    }
    const titleMatches =
      parsed.data.title === undefined || parsed.data.title === current.title;
    const descMatches =
      parsed.data.description === undefined || parsed.data.description === current.description;
    if (titleMatches && descMatches) {
      return reply.send({ data: { updated: 0, reason: 'no-op (values already match)' } });
    }

    const result = await db
      .update(tasks)
      .set(update)
      .where(eq(tasks.id, parsed.data.task_id))
      .returning({ id: tasks.id, project_id: tasks.project_id });

    // Live broadcast on the project channel so any open Bam board picks
    // up the synced change without manual refetch. Loop-safe: this raw
    // write bypassed the updateTask service that fires the outbound
    // sync, so the broadcast won't bounce the change back to Blueprint.
    if (result[0]?.project_id) {
      const payload: Record<string, unknown> = { id: result[0].id };
      if (parsed.data.title !== undefined) payload.title = parsed.data.title;
      if (parsed.data.description !== undefined) payload.description = parsed.data.description;
      payload.sync_source = 'blueprint';
      broadcastToProject(result[0].project_id, 'task.updated', payload);
    }

    return reply.send({ data: { updated: result.length } });
  });
}
