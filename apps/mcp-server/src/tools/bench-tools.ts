import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Helper to make requests to the bench-api service.
 */
function createBenchClient(benchApiUrl: string, api: ApiClient) {
  const baseUrl = benchApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const dashboardShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  visibility: z.string().optional(),
  project_id: z.string().uuid().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const widgetShape = z.object({
  id: z.string().uuid(),
  dashboard_id: z.string().uuid().nullable().optional(),
  name: z.string(),
  widget_type: z.string(),
  data_source: z.string().optional(),
  entity: z.string().optional(),
  query_config: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const reportShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  dashboard_id: z.string().uuid().nullable().optional(),
  cron_expression: z.string().optional(),
  cron_timezone: z.string().optional(),
  delivery_method: z.string().optional(),
  delivery_target: z.string().optional(),
  export_format: z.string().optional(),
  enabled: z.boolean().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

const savedQueryShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable().optional(),
  data_source: z.string(),
  entity: z.string(),
  query_config: z.record(z.unknown()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

// Shared query-config shape, mirrored from apps/bench-api widget/query routes.
const measureSchema = z.object({
  field: z.string(),
  agg: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  alias: z.string().optional(),
});
const dimensionSchema = z.object({
  field: z.string(),
  alias: z.string().optional(),
});
const filterSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null', 'between', 'like']),
  value: z.unknown(),
});
const queryConfigSchema = z.object({
  measures: z.array(measureSchema).min(1),
  dimensions: z.array(dimensionSchema).optional(),
  filters: z.array(filterSchema).optional(),
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

const widgetTypeEnum = z.enum([
  'bar_chart', 'line_chart', 'area_chart', 'pie_chart', 'donut_chart',
  'scatter_plot', 'heatmap', 'funnel',
  'table', 'pivot_table',
  'kpi_card', 'counter', 'gauge', 'progress_bar',
  'text', 'markdown',
]);

export function registerBenchTools(server: McpServer, api: ApiClient, benchApiUrl: string): void {
  const client = createBenchClient(benchApiUrl, api);

  // ===== bench_list_dashboards =====
  registerTool(server, {
    name: 'bench_list_dashboards',
    description: 'List available analytics dashboards for the current organization. Supports filtering by project and visibility.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project ID'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Filter by visibility'),
    },
    returns: z.object({ data: z.array(dashboardShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/dashboards${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing dashboards', result.data);
    },
  });

  // ===== bench_get_dashboard =====
  registerTool(server, {
    name: 'bench_get_dashboard',
    description: 'Get a dashboard with all its widget configurations and layout.',
    input: {
      id: z.string().uuid().describe('Dashboard ID'),
    },
    returns: dashboardShape.extend({ widgets: z.array(z.object({ id: z.string().uuid(), name: z.string(), widget_type: z.string() }).passthrough()).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/dashboards/${id}`);
      return result.ok ? ok(result.data) : err('getting dashboard', result.data);
    },
  });

  // ===== bench_query_widget =====
  registerTool(server, {
    name: 'bench_query_widget',
    description: 'Execute a widget query and return the data results. Returns rows, the generated SQL, and execution time.',
    input: {
      widget_id: z.string().uuid().describe('Widget ID to query'),
    },
    returns: z.object({ rows: z.array(z.record(z.unknown())), sql: z.string().optional(), duration_ms: z.number().optional() }).passthrough(),
    handler: async ({ widget_id }) => {
      const result = await client.request('POST', `/widgets/${widget_id}/query`);
      return result.ok ? ok(result.data) : err('querying widget', result.data);
    },
  });

  // ===== bench_query_ad_hoc =====
  registerTool(server, {
    name: 'bench_query_ad_hoc',
    description: 'Run a structured query against any registered data source. Returns rows, SQL, and duration. Use bench_list_data_sources to discover available sources and their schemas.',
    input: {
      data_source: z.string().describe('Product name (e.g., "bam", "bond", "blast")'),
      entity: z.string().describe('Entity name (e.g., "tasks", "deals", "campaigns")'),
      measures: z.array(z.object({
        field: z.string(),
        agg: z.enum(['count', 'sum', 'avg', 'min', 'max']),
        alias: z.string().optional(),
      })).min(1).describe('Measures to aggregate'),
      dimensions: z.array(z.object({
        field: z.string(),
        alias: z.string().optional(),
      })).optional().describe('Dimensions to group by'),
      filters: z.array(z.object({
        field: z.string(),
        op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null', 'is_not_null', 'between']),
        value: z.unknown(),
      })).optional().describe('Filters to apply'),
      limit: z.number().int().positive().max(1000).optional().describe('Max rows (default 100)'),
    },
    returns: z.object({ rows: z.array(z.record(z.unknown())), sql: z.string().optional(), duration_ms: z.number().optional() }).passthrough(),
    handler: async ({ data_source, entity, measures, dimensions, filters, limit }) => {
      const result = await client.request('POST', '/query/preview', {
        data_source,
        entity,
        query_config: { measures, dimensions, filters, limit: limit ?? 100 },
      });
      return result.ok ? ok(result.data) : err('running ad-hoc query', result.data);
    },
  });

  // ===== bench_summarize_dashboard =====
  registerTool(server, {
    name: 'bench_summarize_dashboard',
    description: 'Get all widget data from a dashboard for AI summarization. Returns the dashboard metadata and query results for each widget.',
    input: {
      dashboard_id: z.string().uuid().describe('Dashboard ID to summarize'),
    },
    returns: z.object({ dashboard: z.object({ id: z.string().uuid(), name: z.string(), widget_count: z.number() }), widget_results: z.record(z.unknown()) }),
    handler: async ({ dashboard_id }) => {
      // Get dashboard with widgets
      const dashResult = await client.request('GET', `/dashboards/${dashboard_id}`);
      if (!dashResult.ok) return err('getting dashboard for summary', dashResult.data);

      const dashboard = (dashResult.data as any).data;
      const widgetResults: Record<string, unknown> = {};

      // Execute each widget's query
      for (const widget of dashboard.widgets ?? []) {
        const queryResult = await client.request('POST', `/widgets/${widget.id}/query`);
        widgetResults[widget.id] = {
          name: widget.name,
          type: widget.widget_type,
          data_source: `${widget.data_source}.${widget.entity}`,
          data: queryResult.ok ? (queryResult.data as any).data : { error: 'query failed' },
        };
      }

      return ok({
        dashboard: {
          id: dashboard.id,
          name: dashboard.name,
          description: dashboard.description,
          widget_count: dashboard.widgets?.length ?? 0,
        },
        widget_results: widgetResults,
      });
    },
  });

  // ===== bench_detect_anomalies =====
  registerTool(server, {
    name: 'bench_detect_anomalies',
    description: 'Scan recent metrics for anomalies. Queries the specified data source and compares the most recent period against the previous period to detect significant deviations.',
    input: {
      data_source: z.string().describe('Product name (e.g., "bam", "bond")'),
      entity: z.string().describe('Entity name (e.g., "tasks", "deals")'),
      measure_field: z.string().describe('Field to measure (e.g., "id" for count)'),
      measure_agg: z.enum(['count', 'sum', 'avg']).describe('Aggregation function'),
      days: z.number().int().positive().max(90).optional().describe('Number of days to analyze (default 7)'),
    },
    returns: z.object({ data_source: z.string(), measure: z.string(), period_days: z.number(), current_period_value: z.unknown(), previous_period_value: z.unknown(), change_percent: z.number(), is_anomaly: z.boolean(), severity: z.enum(['high', 'medium', 'low']) }),
    handler: async ({ data_source, entity, measure_field, measure_agg, days }) => {
      const d = days ?? 7;
      // Current period
      const currentResult = await client.request('POST', '/query/preview', {
        data_source,
        entity,
        query_config: {
          measures: [{ field: measure_field, agg: measure_agg, alias: 'value' }],
          filters: [{ field: 'created_at', op: 'gte', value: new Date(Date.now() - d * 86400000).toISOString() }],
        },
      });

      // Previous period
      const previousResult = await client.request('POST', '/query/preview', {
        data_source,
        entity,
        query_config: {
          measures: [{ field: measure_field, agg: measure_agg, alias: 'value' }],
          filters: [
            { field: 'created_at', op: 'gte', value: new Date(Date.now() - 2 * d * 86400000).toISOString() },
            { field: 'created_at', op: 'lt', value: new Date(Date.now() - d * 86400000).toISOString() },
          ],
        },
      });

      const current = currentResult.ok ? ((currentResult.data as any).data?.rows?.[0]?.value ?? 0) : 0;
      const previous = previousResult.ok ? ((previousResult.data as any).data?.rows?.[0]?.value ?? 0) : 0;
      const change = previous > 0 ? ((Number(current) - Number(previous)) / Number(previous) * 100) : 0;

      return ok({
        data_source: `${data_source}.${entity}`,
        measure: `${measure_agg}(${measure_field})`,
        period_days: d,
        current_period_value: current,
        previous_period_value: previous,
        change_percent: Math.round(change * 10) / 10,
        is_anomaly: Math.abs(change) > 30,
        severity: Math.abs(change) > 50 ? 'high' : Math.abs(change) > 30 ? 'medium' : 'low',
      });
    },
  });

  // ===== bench_generate_report =====
  registerTool(server, {
    name: 'bench_generate_report',
    description: 'Trigger immediate generation and delivery of a scheduled report.',
    input: {
      report_id: z.string().uuid().describe('Scheduled report ID to trigger'),
    },
    returns: z.object({ ok: z.boolean(), delivered_at: z.string().optional() }).passthrough(),
    handler: async ({ report_id }) => {
      const result = await client.request('POST', `/reports/${report_id}/send-now`);
      return result.ok ? ok(result.data) : err('generating report', result.data);
    },
  });

  // ===== bench_list_data_sources =====
  registerTool(server, {
    name: 'bench_list_data_sources',
    description: 'List all available data sources and their schemas (measures, dimensions, filters). Use this to discover what data can be queried through Bench.',
    input: {},
    returns: z.object({ data: z.array(z.object({ name: z.string(), entities: z.array(z.string()) }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/data-sources');
      return result.ok ? ok(result.data) : err('listing data sources', result.data);
    },
  });

  // ===== bench_list_widgets =====
  registerTool(server, {
    name: 'bench_list_widgets',
    description: 'List widgets across the organization, optionally scoped to a single dashboard. Widgets are normally only reachable by nesting inside bench_get_dashboard; this gives them direct addressability for resolver flows. Returns id, name, type, dashboard_id, dashboard_name, position, and query.',
    input: {
      dashboard_id: z.string().uuid().optional().describe('Optional dashboard ID to scope results to'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        type: z.string(),
        dashboard_id: z.string().uuid().nullable().optional(),
        dashboard_name: z.string().nullable().optional(),
        position: z.unknown().nullable().optional(),
        query: z.object({
          data_source: z.string().optional(),
          entity: z.string().optional(),
          config: z.unknown().optional(),
        }).passthrough(),
      }).passthrough()),
    }),
    handler: async (params) => {
      const result = await client.request('GET', `/widgets${buildQs(params)}`);
      if (!result.ok) return err('listing widgets', result.data);

      const rows = (result.data as any)?.data ?? [];
      const widgets = rows.map((w: any) => ({
        id: w.id,
        name: w.name,
        type: w.widget_type,
        dashboard_id: w.dashboard_id,
        dashboard_name: w.dashboard_name,
        position: null,
        query: {
          data_source: w.data_source,
          entity: w.entity,
          config: w.query_config,
        },
      }));
      return ok({ data: widgets });
    },
  });

  // ===== bench_list_scheduled_reports =====
  registerTool(server, {
    name: 'bench_list_scheduled_reports',
    description: 'List scheduled reports for the organization, with optional fuzzy search on name. Returns id, name, dashboard_id, dashboard_name, schedule (cron expression + timezone + enabled), recipients (delivery method/target/format), last_run_at, and next_run_at.',
    input: {
      search: z.string().optional().describe('Optional fuzzy search on report name'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        dashboard_id: z.string().uuid().nullable().optional(),
        dashboard_name: z.string().nullable().optional(),
        schedule: z.object({
          cron_expression: z.string().optional(),
          cron_timezone: z.string().optional(),
          enabled: z.boolean().optional(),
        }).passthrough(),
        recipients: z.object({
          delivery_method: z.string().optional(),
          delivery_target: z.string().optional(),
          export_format: z.string().optional(),
        }).passthrough(),
        last_run_at: z.string().nullable().optional(),
        next_run_at: z.string().nullable().optional(),
      }).passthrough()),
    }),
    handler: async (params) => {
      const result = await client.request('GET', `/reports${buildQs(params)}`);
      if (!result.ok) return err('listing scheduled reports', result.data);

      const rows = (result.data as any)?.data ?? [];
      const reports = rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        dashboard_id: r.dashboard_id,
        dashboard_name: r.dashboard_name,
        schedule: {
          cron_expression: r.cron_expression,
          cron_timezone: r.cron_timezone,
          enabled: r.enabled,
        },
        recipients: {
          delivery_method: r.delivery_method,
          delivery_target: r.delivery_target,
          export_format: r.export_format,
        },
        last_run_at: r.last_sent_at ?? null,
        next_run_at: null,
      }));
      return ok({ data: reports });
    },
  });

  // ===== bench_compare_periods =====
  registerTool(server, {
    name: 'bench_compare_periods',
    description: 'Compare metrics between two time periods. Returns values for both periods and the percentage change.',
    input: {
      data_source: z.string().describe('Product name'),
      entity: z.string().describe('Entity name'),
      measure_field: z.string().describe('Field to measure'),
      measure_agg: z.enum(['count', 'sum', 'avg']).describe('Aggregation function'),
      period1_start: z.string().describe('Start of first period (ISO date)'),
      period1_end: z.string().describe('End of first period (ISO date)'),
      period2_start: z.string().describe('Start of second period (ISO date)'),
      period2_end: z.string().describe('End of second period (ISO date)'),
    },
    returns: z.object({ data_source: z.string(), measure: z.string(), period1: z.object({ start: z.string(), end: z.string(), value: z.number() }), period2: z.object({ start: z.string(), end: z.string(), value: z.number() }), change_percent: z.number(), direction: z.enum(['up', 'down', 'flat']) }),
    handler: async ({ data_source, entity, measure_field, measure_agg, period1_start, period1_end, period2_start, period2_end }) => {
      const q = (start: string, end: string) => client.request('POST', '/query/preview', {
        data_source,
        entity,
        query_config: {
          measures: [{ field: measure_field, agg: measure_agg, alias: 'value' }],
          filters: [
            { field: 'created_at', op: 'gte', value: start },
            { field: 'created_at', op: 'lte', value: end },
          ],
        },
      });

      const [r1, r2] = await Promise.all([
        q(period1_start, period1_end),
        q(period2_start, period2_end),
      ]);

      const v1 = r1.ok ? Number((r1.data as any).data?.rows?.[0]?.value ?? 0) : 0;
      const v2 = r2.ok ? Number((r2.data as any).data?.rows?.[0]?.value ?? 0) : 0;
      const change = v1 > 0 ? ((v2 - v1) / v1 * 100) : 0;

      return ok({
        data_source: `${data_source}.${entity}`,
        measure: `${measure_agg}(${measure_field})`,
        period1: { start: period1_start, end: period1_end, value: v1 },
        period2: { start: period2_start, end: period2_end, value: v2 },
        change_percent: Math.round(change * 10) / 10,
        direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      });
    },
  });

  // ===== DASHBOARDS — CRUD =====

  // ===== bench_create_dashboard =====
  registerTool(server, {
    name: 'bench_create_dashboard',
    description: 'Create a new analytics dashboard. Widgets are added separately via bench_add_widget.',
    input: {
      name: z.string().min(1).max(255).describe('Dashboard name'),
      description: z.string().max(2000).optional().describe('Dashboard description'),
      project_id: z.string().uuid().optional().describe('Project to scope the dashboard to'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Who can see the dashboard (default private)'),
      is_default: z.boolean().optional().describe('Mark as the default dashboard'),
      auto_refresh_seconds: z.number().int().positive().optional().describe('Auto-refresh interval in seconds'),
      layout: z.array(z.record(z.unknown())).optional().describe('Grid layout descriptors'),
    },
    returns: dashboardShape,
    handler: async (params) => {
      const result = await client.request('POST', '/dashboards', params);
      return result.ok ? ok(result.data) : err('creating dashboard', result.data);
    },
  });

  // ===== bench_update_dashboard =====
  registerTool(server, {
    name: 'bench_update_dashboard',
    description: 'Update dashboard metadata (name, description, visibility, layout). Provide only the fields to change.',
    input: {
      id: z.string().uuid().describe('Dashboard ID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      project_id: z.string().uuid().nullable().optional().describe('Updated project scope (null to clear)'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Updated visibility'),
      is_default: z.boolean().optional().describe('Updated default flag'),
      auto_refresh_seconds: z.number().int().positive().nullable().optional().describe('Updated auto-refresh interval (null to clear)'),
      layout: z.array(z.record(z.unknown())).optional().describe('Updated grid layout'),
    },
    returns: dashboardShape,
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/dashboards/${id}`, body);
      return result.ok ? ok(result.data) : err('updating dashboard', result.data);
    },
  });

  // ===== bench_delete_dashboard =====
  registerTool(server, {
    name: 'bench_delete_dashboard',
    description: 'Delete a dashboard and its widgets. This is permanent.',
    input: {
      id: z.string().uuid().describe('Dashboard ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/dashboards/${id}`);
      return result.ok ? ok(result.data) : err('deleting dashboard', result.data);
    },
  });

  // ===== bench_duplicate_dashboard =====
  registerTool(server, {
    name: 'bench_duplicate_dashboard',
    description: 'Clone a dashboard, including its widgets, into a new copy owned by the caller.',
    input: {
      id: z.string().uuid().describe('Dashboard ID to clone'),
    },
    returns: dashboardShape,
    handler: async ({ id }) => {
      const result = await client.request('POST', `/dashboards/${id}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating dashboard', result.data);
    },
  });

  // ===== bench_export_dashboard =====
  registerTool(server, {
    name: 'bench_export_dashboard',
    description: 'Queue a dashboard export render (PDF). Returns the queued job descriptor; the rendered artifact is delivered out of band.',
    input: {
      id: z.string().uuid().describe('Dashboard ID to export'),
    },
    returns: z.object({ dashboard_id: z.string().uuid(), status: z.string(), format: z.string().optional(), queued_at: z.string().optional() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('POST', `/dashboards/${id}/export`);
      return result.ok ? ok(result.data) : err('exporting dashboard', result.data);
    },
  });

  // ===== WIDGETS — CRUD =====

  // ===== bench_add_widget =====
  registerTool(server, {
    name: 'bench_add_widget',
    description: 'Add a widget to a dashboard. The widget binds a data source + entity to a query config and a visualization type. Use bench_list_data_sources to discover valid data_source/entity and field names.',
    input: {
      dashboard_id: z.string().uuid().describe('Dashboard ID to add the widget to'),
      name: z.string().min(1).max(255).describe('Widget name'),
      widget_type: widgetTypeEnum.describe('Visualization type'),
      data_source: z.string().min(1).max(30).describe('Product name (e.g., "bam", "bond")'),
      entity: z.string().min(1).max(60).describe('Entity name (e.g., "tasks", "deals")'),
      query_config: queryConfigSchema.describe('Aggregation query config (measures required)'),
      viz_config: z.record(z.unknown()).optional().describe('Visualization options'),
      kpi_config: z.record(z.unknown()).optional().describe('KPI-card options'),
      cache_ttl_seconds: z.number().int().positive().optional().describe('Result cache TTL in seconds'),
    },
    returns: widgetShape,
    handler: async ({ dashboard_id, ...body }) => {
      const result = await client.request('POST', `/dashboards/${dashboard_id}/widgets`, body);
      return result.ok ? ok(result.data) : err('adding widget', result.data);
    },
  });

  // ===== bench_get_widget =====
  registerTool(server, {
    name: 'bench_get_widget',
    description: 'Get a single widget configuration by ID (data source, entity, query config, visualization).',
    input: {
      id: z.string().uuid().describe('Widget ID'),
    },
    returns: widgetShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/widgets/${id}`);
      return result.ok ? ok(result.data) : err('getting widget', result.data);
    },
  });

  // ===== bench_update_widget =====
  registerTool(server, {
    name: 'bench_update_widget',
    description: 'Update a widget configuration. Provide only the fields to change. Changing query_config replaces it wholesale.',
    input: {
      id: z.string().uuid().describe('Widget ID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      widget_type: widgetTypeEnum.optional().describe('Updated visualization type'),
      data_source: z.string().min(1).max(30).optional().describe('Updated data source'),
      entity: z.string().min(1).max(60).optional().describe('Updated entity'),
      query_config: queryConfigSchema.optional().describe('Replacement query config'),
      viz_config: z.record(z.unknown()).optional().describe('Updated visualization options'),
      kpi_config: z.record(z.unknown()).optional().describe('Updated KPI-card options'),
      cache_ttl_seconds: z.number().int().positive().optional().describe('Updated cache TTL'),
    },
    returns: widgetShape,
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/widgets/${id}`, body);
      return result.ok ? ok(result.data) : err('updating widget', result.data);
    },
  });

  // ===== bench_delete_widget =====
  registerTool(server, {
    name: 'bench_delete_widget',
    description: 'Delete a widget from its dashboard. This is permanent.',
    input: {
      id: z.string().uuid().describe('Widget ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/widgets/${id}`);
      return result.ok ? ok(result.data) : err('deleting widget', result.data);
    },
  });

  // ===== bench_refresh_widget =====
  registerTool(server, {
    name: 'bench_refresh_widget',
    description: 'Force cache invalidation and re-execute a widget query, bypassing any cached result. Use bench_query_widget for a normal (cacheable) read.',
    input: {
      id: z.string().uuid().describe('Widget ID to refresh'),
    },
    returns: z.object({ rows: z.array(z.record(z.unknown())), sql: z.string().optional(), duration_ms: z.number().optional() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('POST', `/widgets/${id}/refresh`);
      return result.ok ? ok(result.data) : err('refreshing widget', result.data);
    },
  });

  // ===== SCHEDULED REPORTS — CRUD =====

  // ===== bench_create_scheduled_report =====
  registerTool(server, {
    name: 'bench_create_scheduled_report',
    description: 'Create a scheduled report that periodically renders a dashboard and delivers it. delivery_target is an email address, Banter channel ID, or Brief document target depending on delivery_method.',
    input: {
      dashboard_id: z.string().uuid().describe('Dashboard to render and deliver'),
      name: z.string().min(1).max(255).describe('Report name'),
      cron_expression: z.string().min(1).max(100).describe('Cron schedule expression'),
      cron_timezone: z.string().max(50).optional().describe('IANA timezone for the cron schedule'),
      delivery_method: z.enum(['email', 'banter_channel', 'brief_document']).describe('How to deliver the rendered report'),
      delivery_target: z.string().min(1).describe('Email address, Banter channel, or Brief document target'),
      export_format: z.enum(['pdf', 'png', 'csv']).optional().describe('Rendered artifact format'),
      enabled: z.boolean().optional().describe('Whether the schedule is active'),
    },
    returns: reportShape,
    handler: async (params) => {
      const result = await client.request('POST', '/reports', params);
      return result.ok ? ok(result.data) : err('creating scheduled report', result.data);
    },
  });

  // ===== bench_update_scheduled_report =====
  registerTool(server, {
    name: 'bench_update_scheduled_report',
    description: 'Update a scheduled report (schedule, delivery, or enabled state). Provide only the fields to change.',
    input: {
      id: z.string().uuid().describe('Scheduled report ID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      cron_expression: z.string().min(1).max(100).optional().describe('Updated cron schedule'),
      cron_timezone: z.string().max(50).optional().describe('Updated timezone'),
      delivery_method: z.enum(['email', 'banter_channel', 'brief_document']).optional().describe('Updated delivery method'),
      delivery_target: z.string().min(1).optional().describe('Updated delivery target'),
      export_format: z.enum(['pdf', 'png', 'csv']).optional().describe('Updated artifact format'),
      enabled: z.boolean().optional().describe('Enable or disable the schedule'),
    },
    returns: reportShape,
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/reports/${id}`, body);
      return result.ok ? ok(result.data) : err('updating scheduled report', result.data);
    },
  });

  // ===== bench_delete_scheduled_report =====
  registerTool(server, {
    name: 'bench_delete_scheduled_report',
    description: 'Delete a scheduled report. This stops future deliveries and is permanent.',
    input: {
      id: z.string().uuid().describe('Scheduled report ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/reports/${id}`);
      return result.ok ? ok(result.data) : err('deleting scheduled report', result.data);
    },
  });

  // ===== SAVED QUERIES — CRUD =====

  // ===== bench_list_saved_queries =====
  registerTool(server, {
    name: 'bench_list_saved_queries',
    description: 'List saved ad-hoc queries for the organization. Saved queries pair a data source + entity with a reusable query config.',
    input: {},
    returns: z.object({ data: z.array(savedQueryShape) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/saved-queries');
      return result.ok ? ok(result.data) : err('listing saved queries', result.data);
    },
  });

  // ===== bench_get_saved_query =====
  registerTool(server, {
    name: 'bench_get_saved_query',
    description: 'Get a single saved query by ID, including its full query config.',
    input: {
      id: z.string().uuid().describe('Saved query ID'),
    },
    returns: savedQueryShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/saved-queries/${id}`);
      return result.ok ? ok(result.data) : err('getting saved query', result.data);
    },
  });

  // ===== bench_create_saved_query =====
  registerTool(server, {
    name: 'bench_create_saved_query',
    description: 'Save a reusable ad-hoc query. The query_config follows the same shape as bench_query_ad_hoc (measures, dimensions, filters).',
    input: {
      name: z.string().min(1).max(255).describe('Saved query name'),
      description: z.string().max(2000).optional().describe('Description'),
      data_source: z.string().min(1).max(30).describe('Product name (e.g., "bam", "bond")'),
      entity: z.string().min(1).max(60).describe('Entity name (e.g., "tasks", "deals")'),
      query_config: z.record(z.unknown()).describe('Query config (measures/dimensions/filters)'),
    },
    returns: savedQueryShape,
    handler: async (params) => {
      const result = await client.request('POST', '/saved-queries', params);
      return result.ok ? ok(result.data) : err('creating saved query', result.data);
    },
  });

  // ===== bench_update_saved_query =====
  registerTool(server, {
    name: 'bench_update_saved_query',
    description: 'Update a saved query. Provide only the fields to change; query_config replaces the existing config wholesale.',
    input: {
      id: z.string().uuid().describe('Saved query ID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      data_source: z.string().min(1).max(30).optional().describe('Updated data source'),
      entity: z.string().min(1).max(60).optional().describe('Updated entity'),
      query_config: z.record(z.unknown()).optional().describe('Replacement query config'),
    },
    returns: savedQueryShape,
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/saved-queries/${id}`, body);
      return result.ok ? ok(result.data) : err('updating saved query', result.data);
    },
  });

  // ===== bench_delete_saved_query =====
  registerTool(server, {
    name: 'bench_delete_saved_query',
    description: 'Delete a saved query. This is permanent.',
    input: {
      id: z.string().uuid().describe('Saved query ID to delete'),
    },
    returns: z.object({ deleted: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/saved-queries/${id}`);
      return result.ok ? ok(result.data) : err('deleting saved query', result.data);
    },
  });

  // ===== DATA SOURCES =====

  // ===== bench_get_data_source =====
  registerTool(server, {
    name: 'bench_get_data_source',
    description: 'Get the detailed schema for one data source entity — its available measures, dimensions, and filterable fields. Use this after bench_list_data_sources to learn valid field names for a query.',
    input: {
      product: z.string().describe('Product name (e.g., "bam", "bond", "blast")'),
      entity: z.string().describe('Entity name (e.g., "tasks", "deals", "campaigns")'),
    },
    returns: z.object({ name: z.string().optional(), measures: z.array(z.unknown()).optional(), dimensions: z.array(z.unknown()).optional() }).passthrough(),
    handler: async ({ product, entity }) => {
      const result = await client.request(
        'GET',
        `/data-sources/${encodeURIComponent(product)}/${encodeURIComponent(entity)}`,
      );
      return result.ok ? ok(result.data) : err('getting data source', result.data);
    },
  });

  // ===== MATERIALIZED VIEWS =====

  // ===== bench_list_materialized_views =====
  registerTool(server, {
    name: 'bench_list_materialized_views',
    description: 'List the Bench materialized views and their refresh state (last refreshed, row count, schedule).',
    input: {},
    returns: z.object({ data: z.array(z.object({ view_name: z.string().optional() }).passthrough()) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/materialized-views');
      return result.ok ? ok(result.data) : err('listing materialized views', result.data);
    },
  });

  // ===== bench_refresh_materialized_view =====
  registerTool(server, {
    name: 'bench_refresh_materialized_view',
    description: 'Manually trigger a REFRESH of a Bench materialized view. This can be expensive; use bench_list_materialized_views to find valid view names.',
    input: {
      view_name: z.string().describe('Materialized view name to refresh'),
    },
    returns: z.object({}).passthrough().describe('Refresh result (view name, refreshed_at, row count)'),
    handler: async ({ view_name }) => {
      const result = await client.request('POST', `/materialized-views/${encodeURIComponent(view_name)}/refresh`);
      return result.ok ? ok(result.data) : err('refreshing materialized view', result.data);
    },
  });
}
