import type { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/attachments.js';
import { tasks } from '../db/schema/tasks.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireProjectAccessForEntity } from '../middleware/authorize.js';
import { dualReadGate } from '../middleware/dual-read.js';

export default async function attachmentRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/attachments',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.task_attachment.create' }), requireScope('read_write'), requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const schema = z.object({
        filename: z.string().max(500),
        content_type: z.string().max(255).optional(),
        size_bytes: z.number().int().positive(),
        storage_key: z.string(),
        thumbnail_key: z.string().optional(),
      });
      const data = schema.parse(request.body);

      const [attachment] = await db
        .insert(attachments)
        .values({
          task_id: request.params.id,
          uploader_id: request.user!.id,
          filename: data.filename,
          content_type: data.content_type ?? null,
          size_bytes: data.size_bytes,
          storage_key: data.storage_key,
          thumbnail_key: data.thumbnail_key ?? null,
        })
        .returning();

      // Increment attachment count on task
      await db
        .update(tasks)
        .set({
          attachment_count: sql`${tasks.attachment_count} + 1`,
          updated_at: new Date(),
        })
        .where(eq(tasks.id, request.params.id));

      return reply.status(201).send({ data: attachment });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/tasks/:id/attachments',
    { preHandler: [requireAuth, requireProjectAccessForEntity('task')] },
    async (request, reply) => {
      const result = await db
        .select()
        .from(attachments)
        .where(eq(attachments.task_id, request.params.id))
        .orderBy(asc(attachments.created_at));

      return reply.send({ data: result });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/attachments/:id',
    { preHandler: [requireAuth, dualReadGate({ legacy: requireMinRole('member'), permission: 'bam.attachment.delete' }), requireScope('read_write'), requireProjectAccessForEntity('attachment')] },
    async (request, reply) => {
      const [existing] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, request.params.id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Attachment not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db.delete(attachments).where(eq(attachments.id, request.params.id));

      // Decrement attachment count on task
      await db
        .update(tasks)
        .set({
          attachment_count: sql`greatest(${tasks.attachment_count} - 1, 0)`,
          updated_at: new Date(),
        })
        .where(eq(tasks.id, existing.task_id));

      return reply.send({ data: { success: true } });
    },
  );
}
