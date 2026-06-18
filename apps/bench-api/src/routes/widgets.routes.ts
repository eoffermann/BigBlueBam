import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as widgetService from '../services/widget.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const queryMeasureSchema = z.object({
  field: z.string().min(1).max(100),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  alias: z.string().max(100).optional(),
});

const queryDimensionSchema = z.object({
  field: z.string().min(1).max(100),
  alias: z.string().max(100).optional(),
});

const queryFilterSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null', 'between', 'like']),
  value: z.unknown(),
});

const queryConfigSchema = z.object({
  measures: z.array(queryMeasureSchema).min(1),
  dimensions: z.array(queryDimensionSchema).optional(),
  filters: z.array(queryFilterSchema).optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
  limit: z.number().int().positive().max(10000).optional(),
  time_dimension: z.object({
    field: z.string(),
    granularity: z.enum(['hour', 'day', 'week', 'month', 'quarter', 'year']),
  }).optional(),
  date_range: z.object({
    preset: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
  }).optional(),
});

const createWidgetSchema = z.object({
  name: z.string().min(1).max(255),
  widget_type: z.enum([
    'bar_chart', 'line_chart', 'area_chart', 'pie_chart', 'donut_chart',
    'scatter_plot', 'heatmap', 'funnel',
    'table', 'pivot_table',
    'kpi_card', 'counter', 'gauge', 'progress_bar',
    'text', 'markdown',
  ]),
  data_source: z.string().min(1).max(30),
  entity: z.string().min(1).max(60),
  query_config: queryConfigSchema,
  viz_config: z.record(z.unknown()).optional(),
  kpi_config: z.record(z.unknown()).optional(),
  cache_ttl_seconds: z.number().int().positive().optional(),
});

const updateWidgetSchema = createWidgetSchema.partial();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listWidgetsQuerySchema = z.object({
  dashboard_id: z.string().uuid().optional(),
});

export default async function widgetRoutes(fastify: FastifyInstance) {
  // GET /widgets — List widgets across the org (optionally filtered by dashboard)
  fastify.get(
    '/widgets',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listWidgetsQuerySchema.parse(request.query);
      const widgets = await widgetService.listWidgets(
        request.user!.org_id,
        query.dashboard_id,
      );
      return reply.send({ data: widgets });
    },
  );

  // POST /dashboards/:id/widgets — Add widget
  fastify.post<{ Params: { id: string } }>(
    '/dashboards/:id/widgets',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = createWidgetSchema.parse(request.body);
      const widget = await widgetService.createWidget(
        request.params.id,
        request.user!.org_id,
        body,
      );
      return reply.status(201).send({ data: widget });
    },
  );

  // GET /widgets/:id — Get widget
  fastify.get<{ Params: { id: string } }>(
    '/widgets/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const widget = await widgetService.getWidget(request.params.id, request.user!.org_id);
      return reply.send({ data: widget });
    },
  );

  // PATCH /widgets/:id — Update widget
  fastify.patch<{ Params: { id: string } }>(
    '/widgets/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const body = updateWidgetSchema.parse(request.body);
      const widget = await widgetService.updateWidget(request.params.id, body, request.user!.org_id);
      return reply.send({ data: widget });
    },
  );

  // DELETE /widgets/:id — Delete widget
  fastify.delete<{ Params: { id: string } }>(
    '/widgets/:id',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      await widgetService.deleteWidget(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /widgets/:id/query — Execute widget query.
  // Accepts an optional `date_range` body that overrides the widget's stored
  // range for this request only (used by the dashboard date-range picker).
  const widgetQueryBodySchema = z
    .object({
      date_range: z
        .object({
          preset: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
        })
        .optional(),
    })
    .optional();

  fastify.post<{ Params: { id: string } }>(
    '/widgets/:id/query',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const body = widgetQueryBodySchema.parse(request.body ?? {});
      const result = await widgetService.executeWidgetQuery(
        request.params.id,
        request.user!.org_id,
        body?.date_range,
      );
      return reply.send({ data: result });
    },
  );

  // POST /widgets/:id/refresh — Force cache invalidation + re-query
  fastify.post<{ Params: { id: string } }>(
    '/widgets/:id/refresh',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const result = await widgetService.refreshWidgetQuery(request.params.id, request.user!.org_id);
      return reply.send({ data: result });
    },
  );
}
