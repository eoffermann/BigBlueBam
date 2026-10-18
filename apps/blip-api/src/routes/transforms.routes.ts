/**
 * Blip transform routes (Blip §9, §15). PUT the PII / payload redaction ruleset
 * for a tracked app (optionally narrowed to one report_type). Admin authority.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as transformService from '../services/transform.service.js';

// Validate rules on write: an unknown action or period used to be stored as-is
// and then silently let the raw value through at ingest.
const ruleSchema = z.object({
  match: z.string().min(1),
  action: z.enum(['drop', 'mask', 'hash', 'truncate', 'pseudonymize']),
  params: z
    .object({
      keep_last: z.number().int().min(0).optional(),
      max_len: z.number().int().min(0).optional(),
      period: z.enum(['day', 'week', 'month']).optional(),
    })
    .optional(),
});

const setTransformSchema = z.object({
  report_type: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  rules: z.array(ruleSchema),
});

export default async function transformsRoutes(fastify: FastifyInstance) {
  // GET the app-wide transform ruleset (member read). Without this the SPA's
  // transform editor 404s on load and can never display the saved rules.
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/transform',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const row = await transformService.getTransform(
          request.params.id,
          request.user!.active_org_id,
        );
        return reply.send({ data: row });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  fastify.put<{ Params: { id: string } }>(
    '/apps/:id/transform',
    {
      preHandler: [requireAuth, requireScope('admin'), fastify.requireCan('blip.transform.manage')],
    },
    async (request, reply) => {
      try {
        const body = setTransformSchema.parse(request.body);
        const row = await transformService.setTransform(
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
