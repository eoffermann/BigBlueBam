/**
 * Tracked-app REST surface (Blip §15). Reads are member-level (requireAuth);
 * writes are admin-level (requireScope('admin') + requireCan). DELETE uses the
 * inline two-step confirm convention: call without confirmation for a preview,
 * again with ?confirm=true or { confirm_action: true } to execute.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as appService from '../services/app.service.js';

const rateLimitSchema = z
  .object({
    refill_per_sec: z.number().nonnegative().optional(),
    burst: z.number().nonnegative().optional(),
    max_body_bytes: z.number().int().positive().optional(),
    max_batch_count: z.number().int().positive().optional(),
    max_capture_body_bytes: z.number().int().positive().optional(),
    max_capture_bytes: z.number().int().positive().optional(),
    max_captures_per_report: z.number().int().positive().optional(),
  })
  .passthrough();

const createAppSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  collection_enabled: z.boolean().optional(),
  rate_limit: rateLimitSchema.nullable().optional(),
});

const updateAppSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
});

const collectionSchema = z.object({ enabled: z.boolean() });

const rateLimitBodySchema = z.object({ rate_limit: rateLimitSchema.nullable() });

export default async function appsRoutes(fastify: FastifyInstance) {
  // POST /apps — declare a tracked app (admin)
  fastify.post(
    '/apps',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.app.create')] },
    async (request, reply) => {
      try {
        const body = createAppSchema.parse(request.body);
        const app = await appService.createApp(body, request.user!.active_org_id, request.user!.id);
        return reply.status(201).send({ data: app });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps — list tracked apps (member)
  fastify.get('/apps', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const apps = await appService.listApps(request.user!.active_org_id);
      return reply.send({ data: apps });
    } catch (err) {
      return sendError(reply, request, err);
    }
  });

  // GET /apps/:id — app detail (member)
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        const app = await appService.getApp(request.params.id, orgId);
        const health = await appService.getAppHealth(request.params.id, orgId);
        return reply.send({ data: { ...app, health } });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /apps/:id — edit app config (admin)
  fastify.patch<{ Params: { id: string } }>(
    '/apps/:id',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.app.update')] },
    async (request, reply) => {
      try {
        const body = updateAppSchema.parse(request.body ?? {});
        const app = await appService.updateApp(request.params.id, request.user!.active_org_id, body);
        return reply.send({ data: app });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // DELETE /apps/:id — delete app + its data (owner; inline two-step confirm)
  fastify.delete<{ Params: { id: string } }>(
    '/apps/:id',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.app.delete')] },
    async (request, reply) => {
      try {
        const orgId = request.user!.active_org_id;
        const app = await appService.getApp(request.params.id, orgId);
        const query = request.query as { confirm?: string };
        const body = (request.body ?? {}) as { confirm_action?: boolean };
        const confirmed = query.confirm === 'true' || body.confirm_action === true;
        if (!confirmed) {
          return reply.send({
            data: {
              preview: true,
              tracked_app_id: app.id,
              name: app.name,
              message:
                'This will permanently delete the tracked app and all of its keys, entries, ' +
                'watches, views, transforms, and retention policies. Re-send with ' +
                '?confirm=true or { "confirm_action": true } to execute.',
            },
          });
        }
        const result = await appService.deleteApp(request.params.id, orgId);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/collection — start/stop collection (admin)
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/collection',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.collection.toggle')] },
    async (request, reply) => {
      try {
        const { enabled } = collectionSchema.parse(request.body);
        const app = await appService.setCollection(
          request.params.id,
          request.user!.active_org_id,
          enabled,
          request.user!.id,
        );
        return reply.send({ data: app });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PUT /apps/:id/rate-limit — set the app-default rate limit (admin)
  fastify.put<{ Params: { id: string } }>(
    '/apps/:id/rate-limit',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.ratelimit.manage')] },
    async (request, reply) => {
      try {
        const { rate_limit } = rateLimitBodySchema.parse(request.body);
        const app = await appService.setRateLimit(
          request.params.id,
          request.user!.active_org_id,
          rate_limit,
        );
        return reply.send({ data: app });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps/:id/types — observed report types (member)
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/types',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const types = await appService.listReportTypes(
          request.params.id,
          request.user!.active_org_id,
        );
        return reply.send({ data: types });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
