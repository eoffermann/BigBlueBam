/**
 * Ingest-key REST surface (Blip §10, §15). All admin-gated. The full token is
 * returned exactly once from POST /apps/:id/keys; thereafter only public columns
 * (never the secret) are exposed. Revoke uses the inline two-step confirm
 * convention. Every key mutation busts the Redis ingest-key cache so a
 * suspend/revoke/rate-limit change takes effect at the edge within a second
 * rather than waiting out the 60s TTL.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import { KEY_CACHE_PREFIX, KEY_INVALIDATE_CHANNEL } from '../lib/ingest-keys.js';
import * as keyService from '../services/key.service.js';

const createKeySchema = z.object({ label: z.string().max(255).nullable().optional() });

const updateKeySchema = z.object({
  label: z.string().max(255).nullable().optional(),
  rate_limit_override: z
    .object({
      refill_per_sec: z.number().nonnegative().optional(),
      burst: z.number().nonnegative().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

const confirmSchema = z.object({ confirm_action: z.boolean().optional() });

/** Drop the cached key entry and notify other instances to do the same. */
async function bustKeyCache(fastify: FastifyInstance, keyId: string): Promise<void> {
  try {
    await fastify.redis.del(KEY_CACHE_PREFIX + keyId);
    await fastify.redis.publish(KEY_INVALIDATE_CHANNEL, keyId);
  } catch {
    // Best-effort: the 60s TTL is the backstop.
  }
}

export default async function keysRoutes(fastify: FastifyInstance) {
  // POST /apps/:id/keys — mint a key (token shown once) (admin)
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/keys',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.key.create')] },
    async (request, reply) => {
      try {
        const { label } = createKeySchema.parse(request.body ?? {});
        const key = await keyService.createKey(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          label ?? null,
        );
        await bustKeyCache(request.server, key.key_id);
        return reply.status(201).send({ data: key });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps/:id/keys — list keys (never the secret) (admin)
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/keys',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.key.list')] },
    async (request, reply) => {
      try {
        const keys = await keyService.listKeys(request.params.id, request.user!.active_org_id);
        return reply.send({ data: keys });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /keys/:id/suspend — suspend / resume (admin)
  fastify.post<{ Params: { id: string } }>(
    '/keys/:id/suspend',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.key.suspend')] },
    async (request, reply) => {
      try {
        const key = await keyService.toggleSuspend(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
        );
        await bustKeyCache(request.server, key.key_id);
        return reply.send({ data: key });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /keys/:id/revoke — revoke (terminal; inline two-step confirm) (admin)
  fastify.post<{ Params: { id: string } }>(
    '/keys/:id/revoke',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.key.revoke')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        const { confirm_action } = confirmSchema.parse(request.body ?? {});
        if (!confirm_action) {
          const existing = await keyService.getKey(request.params.id, orgId);
          return reply.send({
            data: {
              preview: true,
              key_id: existing.key_id,
              label: existing.label,
              message:
                'Revoking is permanent: this token will never authenticate again. ' +
                'Re-send with { "confirm_action": true } to execute.',
            },
          });
        }
        const key = await keyService.revokeKey(request.params.id, orgId, request.user!.id);
        await bustKeyCache(request.server, key.key_id);
        return reply.send({ data: key });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /keys/:id — label / rate-limit override (admin)
  fastify.patch<{ Params: { id: string } }>(
    '/keys/:id',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.key.update')] },
    async (request, reply) => {
      try {
        const body = updateKeySchema.parse(request.body ?? {});
        const key = await keyService.updateKey(request.params.id, request.user!.active_org_id, body);
        await bustKeyCache(request.server, key.key_id);
        return reply.send({ data: key });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
