import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BenchDashboardVisibility = z.enum(['private', 'project', 'organization']);
export const BenchWidgetType = z.enum([
  'bar_chart',
  'line_chart',
  'area_chart',
  'pie_chart',
  'donut_chart',
  'scatter_plot',
  'heatmap',
  'funnel',
  'table',
  'pivot_table',
  'kpi_card',
  'counter',
  'gauge',
  'progress_bar',
  'text',
  'markdown',
]);
export const BenchMeasureAgg = z.enum(['count', 'sum', 'avg', 'min', 'max']);
export const BenchFilterOp = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is_null',
  'is_not_null',
  'between',
  'like',
]);
export const BenchTimeGranularity = z.enum([
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);
export const BenchSortDir = z.enum(['asc', 'desc']);
export const BenchReportDeliveryMethod = z.enum([
  'email',
  'banter_channel',
  'brief_document',
]);
export const BenchReportExportFormat = z.enum(['pdf', 'png', 'csv']);

// ── Query config building blocks ───────────────────────────────────────
export const benchQueryMeasureSchema = z.object({
  field: z.string().min(1).max(100),
  agg: BenchMeasureAgg,
  alias: z.string().max(100).optional(),
});

export const benchQueryDimensionSchema = z.object({
  field: z.string().min(1).max(100),
  alias: z.string().max(100).optional(),
});

export const benchQueryFilterSchema = z.object({
  field: z.string().min(1).max(100),
  op: BenchFilterOp,
  value: z.unknown(),
});

export const benchQuerySortSchema = z.object({
  field: z.string(),
  dir: BenchSortDir,
});

export const benchQueryConfigSchema = z.object({
  measures: z.array(benchQueryMeasureSchema).min(1),
  dimensions: z.array(benchQueryDimensionSchema).optional(),
  filters: z.array(benchQueryFilterSchema).optional(),
  sort: z.array(benchQuerySortSchema).optional(),
  limit: z.number().int().positive().max(10000).optional(),
  time_dimension: z
    .object({
      field: z.string(),
      granularity: BenchTimeGranularity,
    })
    .optional(),
  date_range: z
    .object({
      preset: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .optional(),
});

// ── Dashboard schemas ──────────────────────────────────────────────────
export const createBenchDashboardSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  project_id: z.string().uuid().optional(),
  visibility: BenchDashboardVisibility.optional(),
  is_default: z.boolean().optional(),
  auto_refresh_seconds: z.number().int().positive().optional(),
  layout: z.array(z.record(z.unknown())).optional(),
});

export const updateBenchDashboardSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  project_id: z.string().uuid().nullable().optional(),
  visibility: BenchDashboardVisibility.optional(),
  is_default: z.boolean().optional(),
  auto_refresh_seconds: z.number().int().positive().nullable().optional(),
  layout: z.array(z.record(z.unknown())).optional(),
});

export const listBenchDashboardsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  visibility: BenchDashboardVisibility.optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.string().optional(),
});

// ── Widget schemas ─────────────────────────────────────────────────────
export const createBenchWidgetSchema = z.object({
  name: z.string().min(1).max(255),
  widget_type: BenchWidgetType,
  data_source: z.string().min(1).max(30),
  entity: z.string().min(1).max(60),
  query_config: benchQueryConfigSchema,
  viz_config: z.record(z.unknown()).optional(),
  kpi_config: z.record(z.unknown()).optional(),
  cache_ttl_seconds: z.number().int().positive().optional(),
});

export const updateBenchWidgetSchema = createBenchWidgetSchema.partial();

export const listBenchWidgetsQuerySchema = z.object({
  dashboard_id: z.string().uuid().optional(),
});

// ── Data source preview ───────────────────────────────────────────────
export const previewBenchDataSourceQuerySchema = z.object({
  data_source: z.string().min(1).max(30),
  entity: z.string().min(1).max(60),
  query_config: benchQueryConfigSchema,
});

// ── Report schemas ─────────────────────────────────────────────────────
export const createBenchReportSchema = z.object({
  dashboard_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  cron_expression: z.string().min(1).max(100),
  cron_timezone: z.string().max(50).optional(),
  delivery_method: BenchReportDeliveryMethod,
  delivery_target: z.string().min(1),
  export_format: BenchReportExportFormat.optional(),
  enabled: z.boolean().optional(),
});

export const updateBenchReportSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  cron_expression: z.string().min(1).max(100).optional(),
  cron_timezone: z.string().max(50).optional(),
  delivery_method: BenchReportDeliveryMethod.optional(),
  delivery_target: z.string().min(1).optional(),
  export_format: BenchReportExportFormat.optional(),
  enabled: z.boolean().optional(),
});

export const listBenchReportsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
