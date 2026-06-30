/**
 * Blip saved-view routes (Blip §7.2, §15). CRUD over reusable views. Create and
 * list are member; edits/deletes are member-gated but restricted in the service
 * to the view owner or an admin (org-shared edits require owner/admin).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as viewService from '../services/view.service.js';

const createViewSchema = z.object({
  tracked_app_id: z.string().uuid(),
  report_type: z.string().min(1),
  name: z.string().min(1).max(256),
  scope: z.enum(['private', 'org']),
  spec: z.record(z.unknown()),
  is_default: z.boolean().optional(),
});

const updateViewSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  scope: z.enum(['private', 'org']).optional(),
  spec: z.record(z.unknown()).optional(),
  is_default: z.boolean().optional(),
});

/** Org admins/owners (and SuperUsers) may manage org-shared / others' views. */
function isAdmin(request: FastifyRequest): boolean {
  const u = request.user!;
  return u.is_superuser === true || u.role === 'admin' || u.role === 'owner';
}

export default async function viewsRoutes(fastify: FastifyInstance) {
  // POST /views — create a saved view (owned by the caller).
  fastify.post(
    '/views',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('blip.view.create')] },
    async (request, reply) => {
      try {
        const body = createViewSchema.parse(request.body);
        const row = await viewService.createView(request.user!.active_org_id, request.user!.id, body);
        return reply.status(201).send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps/:id/types/:t/views — list views visible to the caller.
  fastify.get<{ Params: { id: string; t: string } }>(
    '/apps/:id/types/:t/views',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await viewService.listViews(
          request.params.id,
          request.user!.active_org_id,
          decodeURIComponent(request.params.t),
          request.user!.id,
        );
        return reply.send({ data: rows });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // PATCH /views/:id — edit a view (owner or admin).
  fastify.patch<{ Params: { id: string } }>(
    '/views/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      try {
        const body = updateViewSchema.parse(request.body);
        const row = await viewService.updateView(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          isAdmin(request),
          body,
        );
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // DELETE /views/:id — delete a view (owner or admin).
  fastify.delete<{ Params: { id: string } }>(
    '/views/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      try {
        const result = await viewService.deleteView(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          isAdmin(request),
        );
        return reply.send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
