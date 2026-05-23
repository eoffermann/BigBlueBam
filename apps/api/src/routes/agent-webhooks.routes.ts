import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  configureWebhook,
  listDeliveries,
  redeliver,
  rotateWebhookSecret,
} from '../services/agent-webhook.service.js';

/**
 * Agent webhook REST routes (AGENTIC_TODO §20, Wave 5).
 *
 *   POST /v1/agent-runners/:runner_user_id/webhook            — configure
 *   POST /v1/agent-runners/:runner_user_id/webhook/rotate     — rotate secret
 *   GET  /v1/agent-webhook-deliveries                         — list recent
 *   POST /v1/agent-webhook-deliveries/:delivery_id/redeliver  — redeliver
 *
 * The MCP `agent_webhook_*` tools wrap these endpoints; human operators
 * can also hit them directly with a bearer session. All routes are
 * org-scoped; SuperUsers still have to act through their active_org_id
 * for Wave 5 (no cross-org webhook configuration).
 */

const configureBodySchema = z.object({
  webhook_url: z.string().url().max(2048),
  event_filter: z.array(z.string().min(1).max(200)).max(256),
  enabled: z.boolean().optional(),
});

const listQuerySchema = z.object({
  runner_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'delivered', 'failed', 'dead_lettered']).optional(),
  before: z.string().datetime().optional(),
  limit: z
    .preprocess((v) => {
      if (typeof v === 'string') return Number.parseInt(v, 10);
      return v;
    }, z.number().int().min(1).max(200).optional()),
});

export default async function agentWebhooksRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agent-runners/:runner_user_id/webhook
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { runner_user_id: string } }>(
    '/v1/agent-runners/:runner_user_id/webhook',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.agent_runner_webhook.create')] },
    async (request, reply) => {
      const parsed = configureBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid webhook configuration',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const redis = (fastify as unknown as { redis?: import('ioredis').Redis }).redis ?? null;
      const result = await configureWebhook(
        request.params.runner_user_id,
        { org_id: request.user!.active_org_id },
        parsed.data,
        redis,
      );

      if (!result.ok) {
        const status =
          result.code === 'RUNNER_NOT_FOUND' ? 404
          : result.code === 'CROSS_ORG' ? 403
          : result.code === 'UNSAFE_URL' ? 400
          : 400;
        return reply.status(status).send({
          error: {
            code: result.code,
            message: result.reason ?? 'Webhook configure failed',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({
        data: {
          runner_id: result.runner_id,
          webhook_url: result.webhook_url,
          event_filter: result.event_filter,
          enabled: result.enabled,
          plaintext_secret: result.plaintext_secret,
          plaintext_notice:
            'Store this secret now. It is returned exactly once and cannot be retrieved later. Use agent_webhook_rotate_secret to generate a new one.',
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agent-runners/:runner_user_id/webhook/rotate
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { runner_user_id: string } }>(
    '/v1/agent-runners/:runner_user_id/webhook/rotate',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.agent_runner_webhook.rotate')] },
    async (request, reply) => {
      const redis = (fastify as unknown as { redis?: import('ioredis').Redis }).redis ?? null;
      const result = await rotateWebhookSecret(
        request.params.runner_user_id,
        { org_id: request.user!.active_org_id },
        redis,
      );

      if (!result.ok) {
        const status =
          result.code === 'RUNNER_NOT_FOUND' ? 404
          : result.code === 'CROSS_ORG' ? 403
          : 400;
        return reply.status(status).send({
          error: {
            code: result.code,
            message: 'Webhook secret rotation failed',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({
        data: {
          runner_id: result.runner_id,
          plaintext_secret: result.plaintext_secret,
          plaintext_notice:
            'Store this secret now. The predecessor was invalidated atomically; the next delivery will be signed with this new secret.',
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/agent-webhook-deliveries
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/v1/agent-webhook-deliveries',
    { preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.agent_webhook_delivery.list')] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid webhook-delivery list query',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const rows = await listDeliveries(
        { org_id: request.user!.active_org_id },
        parsed.data,
      );
      return reply.send({ data: rows });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agent-webhook-deliveries/:delivery_id/redeliver
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { delivery_id: string } }>(
    '/v1/agent-webhook-deliveries/:delivery_id/redeliver',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.agent_webhook_delivery.redeliver')] },
    async (request, reply) => {
      // Enqueue via BullMQ. We construct a short-lived queue here rather
      // than caching a module-level instance because agent webhook volume
      // is low and route-scoped queues keep the connection count
      // predictable under load. The worker side reuses the same queue
      // name (`agent-webhook-dispatch`).
      const redis = (fastify as unknown as { redis: import('ioredis').Redis }).redis;
      const { Queue } = await import('bullmq');
      const queue = new Queue('agent-webhook-dispatch', { connection: redis });
      const enqueue = async (deliveryId: string): Promise<string> => {
        const job = await queue.add(
          'dispatch',
          { delivery_id: deliveryId },
          {
            attempts: 1,
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
        return job.id ?? deliveryId;
      };

      const result = await redeliver(
        request.params.delivery_id,
        { org_id: request.user!.active_org_id },
        enqueue,
      );

      await queue.close();

      if (!result.ok) {
        const status = result.code === 'DELIVERY_NOT_FOUND' ? 404 : 400;
        return reply.status(status).send({
          error: {
            code: result.code,
            message: 'Redelivery failed',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({
        data: {
          id: result.id,
          status: result.status,
          enqueued_job_id: result.enqueued_job_id,
        },
      });
    },
  );
}
