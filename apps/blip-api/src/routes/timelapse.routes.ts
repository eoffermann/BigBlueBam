/**
 * Blip timelapse routes (Blip §23.4, §15). Queue a timelapse compilation job,
 * read a job's status (+ Bin video asset when ready), and list jobs for an app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { sendError } from '../lib/send-error.js';
import * as timelapseService from '../services/timelapse.service.js';

const createTimelapseSchema = z.object({
  filter: z.record(z.unknown()).nullable().optional(),
  order: z.unknown().optional(),
  frame_duration_sec: z.number().positive().optional(),
  image_selection: z.enum(['first', 'all']).optional(),
  max_dimension: z.number().int().positive().optional(),
  report_type: z.string().min(1).nullable().optional(),
});

export default async function timelapseRoutes(fastify: FastifyInstance) {
  // POST /apps/:id/timelapse — queue a timelapse compilation job.
  fastify.post<{ Params: { id: string } }>(
    '/apps/:id/timelapse',
    { preHandler: [requireAuth, requireScope('read_write'), fastify.requireCan('blip.timelapse.create')] },
    async (request, reply) => {
      try {
        const body = createTimelapseSchema.parse(request.body ?? {});
        const result = await timelapseService.createTimelapse(
          request.params.id,
          request.user!.active_org_id,
          request.user!.id,
          body,
        );
        return reply.status(202).send({ data: result });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /timelapse/:id — job status + video asset ref when ready.
  fastify.get<{ Params: { id: string } }>(
    '/timelapse/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const job = await timelapseService.getJob(request.params.id, request.user!.active_org_id);
        return reply.send({ data: job });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );

  // GET /apps/:id/timelapse — list timelapse jobs for an app.
  fastify.get<{ Params: { id: string } }>(
    '/apps/:id/timelapse',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const jobs = await timelapseService.listJobs(request.params.id, request.user!.active_org_id);
        return reply.send({ data: jobs });
      } catch (err) {
        return sendError(reply, request, err);
      }
    },
  );
}
