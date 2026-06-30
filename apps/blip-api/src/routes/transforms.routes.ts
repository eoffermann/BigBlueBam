/**
 * Blip transform routes (Blip §9, §15). PUT the PII / payload redaction ruleset
 * for a tracked app (optionally narrowed to one report_type). Admin authority.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as transformService from '../services/transform.service.js';

const setTransformSchema = z.object({
  report_type: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  rules: z.array(z.unknown()),
});

export default async function transformsRoutes(fastify: FastifyInstance) {
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
