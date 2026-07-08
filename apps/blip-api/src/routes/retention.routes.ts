/**
 * Blip retention routes (Blip §11.2, §15). PUT the retention policy for a tracked
 * app (or one report_type; report_type null = the app-wide default). Admin.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as retentionService from '../services/retention.service.js';

const setRetentionSchema = z.object({
  report_type: z.string().min(1).nullable().optional(),
  max_age_days: z.number().int().positive().nullable().optional(),
  max_rows: z.number().int().positive().nullable().optional(),
  max_bytes: z.number().int().positive().nullable().optional(),
});

export default async function retentionRoutes(fastify: FastifyInstance) {
  // GET all retention policies for the app (member read). Without this the SPA's
  // retention page 404s on load and can never show the configured policy.
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/retention',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const rows = await retentionService.listRetention(
          request.params.id,
          request.user!.active_org_id,
        );
        return reply.send({ data: rows });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/apps/:id/retention',
    {
      preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.retention.manage')],
    },
    async (request, reply) => {
      try {
        const body = setRetentionSchema.parse(request.body);
        const row = await retentionService.setRetention(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          body,
        );
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
