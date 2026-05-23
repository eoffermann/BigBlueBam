import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import * as reportService from '../services/report.service.js';

const dateRangeSchema = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

export default async function reportRoutes(fastify: FastifyInstance) {
  // GET /reports/revenue
  fastify.get(
    '/reports/revenue',
    { preHandler: [requireAuth, fastify.requireCan('bill.report_revenue.list')] },
    async (request, reply) => {
      const query = dateRangeSchema.parse(request.query);
      const result = await reportService.getRevenueSummary(
        request.user!.org_id,
        query.date_from,
        query.date_to,
      );
      return reply.send(result);
    },
  );

  // GET /reports/outstanding
  fastify.get(
    '/reports/outstanding',
    { preHandler: [requireAuth, fastify.requireCan('bill.report_outstanding.list')] },
    async (request, reply) => {
      const result = await reportService.getOutstanding(request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /reports/profitability
  fastify.get(
    '/reports/profitability',
    { preHandler: [requireAuth, fastify.requireCan('bill.report_profitability.list')] },
    async (request, reply) => {
      const result = await reportService.getProfitability(request.user!.org_id);
      return reply.send(result);
    },
  );

  // GET /reports/overdue
  fastify.get(
    '/reports/overdue',
    { preHandler: [requireAuth, fastify.requireCan('bill.report_overdue.list')] },
    async (request, reply) => {
      const result = await reportService.getOverdue(request.user!.org_id);
      return reply.send(result);
    },
  );
}
