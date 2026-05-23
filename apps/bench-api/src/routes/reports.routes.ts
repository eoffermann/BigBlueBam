import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as reportService from '../services/report.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const createReportSchema = z.object({
  dashboard_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  cron_expression: z.string().min(1).max(100),
  cron_timezone: z.string().max(50).optional(),
  delivery_method: z.enum(['email', 'banter_channel', 'brief_document']),
  delivery_target: z.string().min(1),
  export_format: z.enum(['pdf', 'png', 'csv']).optional(),
  enabled: z.boolean().optional(),
});

const updateReportSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cron_expression: z.string().min(1).max(100).optional(),
  cron_timezone: z.string().max(50).optional(),
  delivery_method: z.enum(['email', 'banter_channel', 'brief_document']).optional(),
  delivery_target: z.string().min(1).optional(),
  export_format: z.enum(['pdf', 'png', 'csv']).optional(),
  enabled: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function reportRoutes(fastify: FastifyInstance) {
  // GET /reports — List reports (optional fuzzy search on name)
  fastify.get(
    '/reports',
    { preHandler: [requireAuth, fastify.requireCan('bench.report.list')] },
    async (request, reply) => {
      const query = z.object({ search: z.string().optional() }).parse(request.query);
      const reports = await reportService.listReports(
        request.user!.org_id,
        query.search,
      );
      return reply.send({ data: reports });
    },
  );

  // POST /reports — Create report
  fastify.post(
    '/reports',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bench.report.create'), requireScope('admin')],
    },
    async (request, reply) => {
      const body = createReportSchema.parse(request.body);
      const report = await reportService.createReport(
        request.user!.org_id,
        request.user!.id,
        body,
      );
      return reply.status(201).send({ data: report });
    },
  );

  // PATCH /reports/:id — Update report
  fastify.patch<{ Params: { id: string } }>(
    '/reports/:id',
    { preHandler: [requireAuth, fastify.requireCan('bench.report.update'), requireScope('admin')] },
    async (request, reply) => {
      const body = updateReportSchema.parse(request.body);
      const report = await reportService.updateReport(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.send({ data: report });
    },
  );

  // DELETE /reports/:id — Delete report
  fastify.delete<{ Params: { id: string } }>(
    '/reports/:id',
    { preHandler: [requireAuth, fastify.requireCan('bench.report.delete'), requireScope('admin')] },
    async (request, reply) => {
      await reportService.deleteReport(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /reports/:id/send-now — Trigger immediate report
  fastify.post<{ Params: { id: string } }>(
    '/reports/:id/send-now',
    { preHandler: [requireAuth, fastify.requireCan('bench.report_send_now.create')] },
    async (request, reply) => {
      const result = await reportService.sendReportNow(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: result });
    },
  );
}
