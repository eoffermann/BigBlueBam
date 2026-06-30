/**
 * Blip watch routes (Blip §12, §15). Match/window watch CRUD plus ops: enable/
 * disable, a predicate dry-run, and firing history. Create/update/enable/delete
 * are admin; reads and the dry-run are member. Delete uses the inline
 * confirm_action two-step convention.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as watchService from '../services/watch.service.js';

const createWatchSchema = z.object({
  report_type: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(256),
  description: z.string().nullable().optional(),
  kind: z.enum(['match', 'window']),
  predicate: z.record(z.unknown()),
  cooldown_sec: z.number().int().min(0).optional(),
});

const updateWatchSchema = z.object({
  report_type: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(256).optional(),
  description: z.string().nullable().optional(),
  kind: z.enum(['match', 'window']).optional(),
  predicate: z.record(z.unknown()).optional(),
  cooldown_sec: z.number().int().min(0).optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });

const deleteSchema = z.object({ confirm_action: z.boolean().optional() });

const testSchema = z.object({
  report_type: z.string().min(1),
  predicate: z.record(z.unknown()),
  kind: z.enum(['match', 'window']),
});

export default async function watchesRoutes(fastify: FastifyInstance) {
  // POST /apps/:id/watches — create a watch.
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/watches',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.watch.create')] },
    async (request, reply) => {
      try {
        const body = createWatchSchema.parse(request.body);
        const row = await watchService.createWatch(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          body,
        );
        return reply.status(201).send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps/:id/watches — list watches for an app.
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/watches',
    { preHandler: [requireAuth, fastify.requireCan('blip.watch.read')] },
    async (request, reply) => {
      try {
        const rows = await watchService.listWatches(request.params.id, request.user!.active_org_id);
        return reply.send({ data: rows });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /apps/:id/watches/test — dry-run a predicate over recent entries.
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/watches/test',
    { preHandler: [requireAuth, fastify.requireCan('blip.watch.test')] },
    async (request, reply) => {
      try {
        const body = testSchema.parse(request.body);
        const result = await watchService.testWatch(request.params.id, request.user!.active_org_id, body);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /watches/:id — watch detail.
  fastify.get<{ Params: { id: string } }>(
    '/watches/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const row = await watchService.getWatch(request.params.id, request.user!.active_org_id);
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /watches/:id — edit a watch.
  fastify.patch<{ Params: { id: string } }>(
    '/watches/:id',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.watch.update')] },
    async (request, reply) => {
      try {
        const body = updateWatchSchema.parse(request.body);
        const row = await watchService.updateWatch(request.params.id, request.user!.active_org_id, body);
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // POST /watches/:id/enabled — enable / disable a watch.
  fastify.post<{ Params: { id: string } }>(
    '/watches/:id/enabled',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.watch.enable')] },
    async (request, reply) => {
      try {
        const body = enabledSchema.parse(request.body);
        const row = await watchService.setEnabled(
          request.params.id,
          request.user!.active_org_id,
          body.enabled,
        );
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // DELETE /watches/:id — delete a watch (inline confirm_action two-step).
  fastify.delete<{ Params: { id: string } }>(
    '/watches/:id',
    { preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.watch.delete')] },
    async (request, reply) => {
      try {
        const body = deleteSchema.parse(request.body ?? {});
        if (!body.confirm_action) {
          const watch = await watchService.getWatch(request.params.id, request.user!.active_org_id);
          return reply.send({
            data: {
              requires_confirmation: true,
              message: `Re-send with confirm_action: true to delete watch "${watch.name}".`,
              watch,
            },
          });
        }
        const result = await watchService.deleteWatch(request.params.id, request.user!.active_org_id);
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /watches/:id/history — recent firings of a watch.
  fastify.get<{ Params: { id: string } }>(
    '/watches/:id/history',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await watchService.watchHistory(request.params.id, request.user!.active_org_id);
        return reply.send({ data: rows });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
