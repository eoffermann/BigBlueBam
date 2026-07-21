import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { neutralizeCsvValue } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as reportGenerator from '../services/report-generator.js';
import * as goalService from '../services/goal.service.js';
import * as krService from '../services/key-result.service.js';

const generateReportSchema = z.object({
  type: z.enum(['period', 'at_risk', 'owner']),
  period_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
});

const exportGoalsQuerySchema = z.object({
  period_id: z.string().uuid().optional(),
  scope: z.string().optional(),
  status: z.string().optional(),
});

const exportKrQuerySchema = z.object({
  goal_id: z.string().uuid().optional(),
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function reportRoutes(fastify: FastifyInstance) {
  // GET /reports/period/:periodId — Period report
  fastify.get<{ Params: { periodId: string } }>(
    '/reports/period/:periodId',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.report_period.get')],
    },
    async (request, reply) => {
      if (!UUID_REGEX.test(request.params.periodId)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid period id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      const report = await reportGenerator.generatePeriodReport(
        request.params.periodId,
        request.user!.org_id,
      );
      return reply.send({ data: report });
    },
  );

  // GET /reports/at-risk — At-risk goals report
  fastify.get(
    '/reports/at-risk',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.report_at_risk.list')],
    },
    async (request, reply) => {
      const report = await reportGenerator.generateAtRiskReport(request.user!.org_id);
      return reply.send({ data: report });
    },
  );

  // GET /reports/owner/:userId — User's goals report
  fastify.get<{ Params: { userId: string } }>(
    '/reports/owner/:userId',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.report_owner.get')],
    },
    async (request, reply) => {
      if (!UUID_REGEX.test(request.params.userId)) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'Valid user id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      const report = await reportGenerator.generateOwnerReport(
        request.params.userId,
        request.user!.org_id,
      );
      return reply.send({ data: report });
    },
  );

  // POST /reports/generate — Generate formatted report
  fastify.post(
    '/reports/generate',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.report_generate.create')],
    },
    async (request, reply) => {
      const { type, period_id, user_id } = generateReportSchema.parse(request.body);

      let report;
      switch (type) {
        case 'period':
          if (!period_id) {
            return reply.status(400).send({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'period_id is required for period reports',
                details: [],
                request_id: request.id,
              },
            });
          }
          report = await reportGenerator.generatePeriodReport(period_id, request.user!.org_id);
          break;
        case 'at_risk':
          report = await reportGenerator.generateAtRiskReport(request.user!.org_id);
          break;
        case 'owner':
          report = await reportGenerator.generateOwnerReport(
            user_id ?? request.user!.id,
            request.user!.org_id,
          );
          break;
      }

      return reply.send({ data: report });
    },
  );

  // ── CSV Export ─────────────────────────────────────────────────────────

  // GET /goals/export — Export goals as CSV
  fastify.get(
    '/goals/export',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.goal.list')],
    },
    async (request, reply) => {
      const query = exportGoalsQuerySchema.parse(request.query);
      const result = await goalService.listGoals({
        orgId: request.user!.org_id,
        periodId: query.period_id,
        scope: query.scope,
        status: query.status,
        limit: 100,
      });

      // Collect all pages (goals use cursor pagination; exhaust it).
      let allGoals = [...result.data];
      let cursor = result.meta.next_cursor;
      while (cursor) {
        const page = await goalService.listGoals({
          orgId: request.user!.org_id,
          periodId: query.period_id,
          scope: query.scope,
          status: query.status,
          cursor,
          limit: 100,
        });
        allGoals = allGoals.concat(page.data);
        cursor = page.meta.next_cursor;
      }

      const header = 'id,title,scope,status,progress,period_id,owner_id,project_id,created_at,updated_at';
      const rows = allGoals.map((g) =>
        [
          g.id,
          csvEscape(g.title),
          g.scope,
          g.status,
          g.progress ?? '',
          g.period_id,
          g.owner_id ?? '',
          g.project_id ?? '',
          g.created_at?.toISOString?.() ?? g.created_at ?? '',
          g.updated_at?.toISOString?.() ?? g.updated_at ?? '',
        ].join(','),
      );

      const csv = [header, ...rows].join('\n');

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="goals-export.csv"')
        .send(csv);
    },
  );

  // GET /key-results/export — Export key results as CSV
  fastify.get(
    '/key-results/export',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bearing.key_result.list')],
    },
    async (request, reply) => {
      const query = exportKrQuerySchema.parse(request.query);

      // If a goal_id is provided, export KRs for that goal.
      // Otherwise, fetch all goals in the org and export their KRs.
      let goalIds: string[] = [];
      if (query.goal_id) {
        goalIds = [query.goal_id];
      } else {
        const result = await goalService.listGoals({
          orgId: request.user!.org_id,
          limit: 100,
        });
        let allGoals = [...result.data];
        let cursor = result.meta.next_cursor;
        while (cursor) {
          const page = await goalService.listGoals({
            orgId: request.user!.org_id,
            cursor,
            limit: 100,
          });
          allGoals = allGoals.concat(page.data);
          cursor = page.meta.next_cursor;
        }
        goalIds = allGoals.map((g) => g.id);
      }

      const allKrs: Record<string, unknown>[] = [];
      for (const gid of goalIds) {
        const { data: krs } = await krService.listKeyResults(gid);
        for (const kr of krs) {
          allKrs.push({ ...kr, goal_id: gid });
        }
      }

      const header = 'id,goal_id,title,metric_type,target_value,current_value,start_value,unit,direction,progress_mode,sort_order,created_at';
      const rows = allKrs.map((kr: Record<string, unknown>) =>
        [
          kr.id ?? '',
          kr.goal_id ?? '',
          csvEscape(String(kr.title ?? '')),
          kr.metric_type ?? '',
          kr.target_value ?? '',
          kr.current_value ?? '',
          kr.start_value ?? '',
          csvEscape(String(kr.unit ?? '')),
          kr.direction ?? '',
          kr.progress_mode ?? '',
          kr.sort_order ?? '',
          (kr.created_at as Date)?.toISOString?.() ?? kr.created_at ?? '',
        ].join(','),
      );

      const csv = [header, ...rows].join('\n');

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="key-results-export.csv"')
        .send(csv);
    },
  );
}

/** Escape a string value for CSV output, neutralizing spreadsheet formula injection first. */
function csvEscape(value: string): string {
  const v = neutralizeCsvValue(value);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
