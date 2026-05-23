import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { webhooks } from '../db/schema/webhooks.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess, requireProjectAccessForEntity } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

/** BAM-028: Hash a webhook secret with SHA-256 before storage. */
function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export default async function webhookRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/webhooks',
    { preHandler: [requireAuth, requireProjectAccess(), shadowOnly('bam.project_webhook.get')] },
    async (request, reply) => {
      const result = await db
        .select({
          id: webhooks.id,
          project_id: webhooks.project_id,
          url: webhooks.url,
          events: webhooks.events,
          is_active: webhooks.is_active,
          created_at: webhooks.created_at,
          updated_at: webhooks.updated_at,
        })
        .from(webhooks)
        .where(eq(webhooks.project_id, request.params.id))
        .orderBy(asc(webhooks.created_at));

      return reply.send({ data: result });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/webhooks',
    { preHandler: [requireAuth, fastify.requireCan('bam.project_webhook.create'), requireScope('read_write')] },
    async (request, reply) => {
      const schema = z.object({
        url: z.string().url(),
        events: z.array(z.string()),
        secret: z.string().min(16),
      });
      const data = schema.parse(request.body);

      // BAM-028: Hash the secret before storing. Return the plaintext
      // secret exactly once in the creation response so the caller can
      // save it; subsequent reads only return a masked placeholder.
      const hashedSecret = hashWebhookSecret(data.secret);

      const [webhook] = await db
        .insert(webhooks)
        .values({
          project_id: request.params.id,
          url: data.url,
          events: data.events,
          secret: hashedSecret,
        })
        .returning({
          id: webhooks.id,
          project_id: webhooks.project_id,
          url: webhooks.url,
          events: webhooks.events,
          is_active: webhooks.is_active,
          created_at: webhooks.created_at,
          updated_at: webhooks.updated_at,
        });

      return reply.status(201).send({ data: { ...webhook, secret: data.secret } });
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.webhook.update'), requireScope('read_write'), requireProjectAccessForEntity('webhook')] },
    async (request, reply) => {
      const schema = z.object({
        url: z.string().url().optional(),
        events: z.array(z.string()).optional(),
        secret: z.string().min(16).optional(),
        is_active: z.boolean().optional(),
      });
      const data = schema.parse(request.body);

      const updateValues: Record<string, unknown> = { updated_at: new Date() };
      if (data.url !== undefined) updateValues.url = data.url;
      if (data.events !== undefined) updateValues.events = data.events;
      if (data.secret !== undefined) updateValues.secret = hashWebhookSecret(data.secret);
      if (data.is_active !== undefined) updateValues.is_active = data.is_active;

      const [webhook] = await db
        .update(webhooks)
        .set(updateValues)
        .where(eq(webhooks.id, request.params.id))
        .returning({
          id: webhooks.id,
          project_id: webhooks.project_id,
          url: webhooks.url,
          events: webhooks.events,
          is_active: webhooks.is_active,
          created_at: webhooks.created_at,
          updated_at: webhooks.updated_at,
        });

      if (!webhook) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Webhook not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: webhook });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/webhooks/:id',
    { preHandler: [requireAuth, fastify.requireCan('bam.webhook.delete'), requireScope('read_write'), requireProjectAccessForEntity('webhook')] },
    async (request, reply) => {
      const [deleted] = await db
        .delete(webhooks)
        .where(eq(webhooks.id, request.params.id))
        .returning();

      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Webhook not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: { success: true } });
    },
  );
}
