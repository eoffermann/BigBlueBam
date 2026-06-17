import { eq, and, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { benchWidgets, benchDashboards } from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';
import { getDataSource } from '../lib/data-source-registry.js';
import * as queryService from './query.service.js';
import type { QueryConfig } from './query.service.js';
import type { CacheService } from './cache.service.js';

// ---------------------------------------------------------------------------
// Cache singleton — set once from server.ts after Redis is ready
// ---------------------------------------------------------------------------

let cacheService: CacheService | null = null;

export function setCacheService(svc: CacheService): void {
  cacheService = svc;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateWidgetInput {
  name: string;
  widget_type: string;
  data_source: string;
  entity: string;
  query_config: QueryConfig;
  viz_config?: Record<string, unknown>;
  kpi_config?: Record<string, unknown>;
  cache_ttl_seconds?: number;
}

export interface UpdateWidgetInput {
  name?: string;
  widget_type?: string;
  data_source?: string;
  entity?: string;
  query_config?: QueryConfig;
  viz_config?: Record<string, unknown>;
  kpi_config?: Record<string, unknown>;
  cache_ttl_seconds?: number | null;
}

// ---------------------------------------------------------------------------
// Create widget
// ---------------------------------------------------------------------------

export async function createWidget(
  dashboardId: string,
  orgId: string,
  input: CreateWidgetInput,
) {
  // Verify dashboard exists and belongs to org
  const [dash] = await db
    .select({ id: benchDashboards.id })
    .from(benchDashboards)
    .where(and(eq(benchDashboards.id, dashboardId), eq(benchDashboards.organization_id, orgId)))
    .limit(1);

  if (!dash) throw notFound('Dashboard not found');

  // Verify data source exists
  const source = getDataSource(input.data_source, input.entity);
  if (!source) throw badRequest(`Unknown data source: ${input.data_source}.${input.entity}`);

  const [widget] = await db
    .insert(benchWidgets)
    .values({
      dashboard_id: dashboardId,
      name: input.name,
      widget_type: input.widget_type,
      data_source: input.data_source,
      entity: input.entity,
      query_config: input.query_config,
      viz_config: input.viz_config ?? {},
      kpi_config: input.kpi_config,
      cache_ttl_seconds: input.cache_ttl_seconds,
    })
    .returning();

  return widget!;
}

// ---------------------------------------------------------------------------
// List widgets (optionally scoped to a dashboard)
// ---------------------------------------------------------------------------

export async function listWidgets(orgId: string, dashboardId?: string) {
  const conditions = [eq(benchDashboards.organization_id, orgId)];
  if (dashboardId) {
    conditions.push(eq(benchWidgets.dashboard_id, dashboardId));
  }

  const rows = await db
    .select({
      id: benchWidgets.id,
      name: benchWidgets.name,
      widget_type: benchWidgets.widget_type,
      data_source: benchWidgets.data_source,
      entity: benchWidgets.entity,
      query_config: benchWidgets.query_config,
      dashboard_id: benchWidgets.dashboard_id,
      dashboard_name: benchDashboards.name,
      created_at: benchWidgets.created_at,
      updated_at: benchWidgets.updated_at,
    })
    .from(benchWidgets)
    .innerJoin(benchDashboards, eq(benchWidgets.dashboard_id, benchDashboards.id))
    .where(and(...conditions))
    .orderBy(asc(benchDashboards.name), asc(benchWidgets.created_at));

  return rows;
}

// ---------------------------------------------------------------------------
// Get widget
// ---------------------------------------------------------------------------

export async function getWidget(id: string, orgId?: string) {
  const query = db
    .select({ widget: benchWidgets })
    .from(benchWidgets)
    .innerJoin(benchDashboards, eq(benchWidgets.dashboard_id, benchDashboards.id))
    .where(
      orgId
        ? and(eq(benchWidgets.id, id), eq(benchDashboards.organization_id, orgId))
        : eq(benchWidgets.id, id),
    )
    .limit(1);

  const [row] = await query;
  if (!row) throw notFound('Widget not found');
  return row.widget;
}

// ---------------------------------------------------------------------------
// Update widget
// ---------------------------------------------------------------------------

export async function updateWidget(id: string, input: UpdateWidgetInput, orgId?: string) {
  // Verify widget belongs to caller's org before updating
  if (orgId) await getWidget(id, orgId);
  if (input.data_source && input.entity) {
    const source = getDataSource(input.data_source, input.entity);
    if (!source) throw badRequest(`Unknown data source: ${input.data_source}.${input.entity}`);
  }

  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.widget_type !== undefined) updateData.widget_type = input.widget_type;
  if (input.data_source !== undefined) updateData.data_source = input.data_source;
  if (input.entity !== undefined) updateData.entity = input.entity;
  if (input.query_config !== undefined) updateData.query_config = input.query_config;
  if (input.viz_config !== undefined) updateData.viz_config = input.viz_config;
  if (input.kpi_config !== undefined) updateData.kpi_config = input.kpi_config;
  if (input.cache_ttl_seconds !== undefined) updateData.cache_ttl_seconds = input.cache_ttl_seconds;

  const [updated] = await db
    .update(benchWidgets)
    .set(updateData)
    .where(eq(benchWidgets.id, id))
    .returning();

  if (!updated) throw notFound('Widget not found');

  // Invalidate cached query result when widget config changes
  if (cacheService) {
    await cacheService.invalidate(id);
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Delete widget
// ---------------------------------------------------------------------------

export async function deleteWidget(id: string, orgId?: string) {
  // Verify widget belongs to caller's org before deleting
  if (orgId) await getWidget(id, orgId);
  const [deleted] = await db
    .delete(benchWidgets)
    .where(eq(benchWidgets.id, id))
    .returning({ id: benchWidgets.id });

  if (!deleted) throw notFound('Widget not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Execute widget query (with Redis cache)
// ---------------------------------------------------------------------------

export async function executeWidgetQuery(
  id: string,
  orgId: string,
  dateRangeOverride?: queryService.DateRange,
) {
  const widget = await getWidget(id);

  const baseConfig = widget.query_config as QueryConfig;
  // A per-request date range (from the dashboard date-range picker) overrides
  // whatever range the widget was saved with. When one is supplied we must NOT
  // use the widget-level cache (which is keyed by widget id only and would
  // otherwise serve a result computed for a different range); the underlying
  // query.service still applies its own date-range-aware ad-hoc cache.
  const hasOverride = !!(dateRangeOverride && (dateRangeOverride.preset || dateRangeOverride.start || dateRangeOverride.end));
  const config: QueryConfig = hasOverride
    ? { ...baseConfig, date_range: dateRangeOverride }
    : baseConfig;

  // Check cache first (only when running the widget's own saved configuration)
  if (cacheService && !hasOverride) {
    const cached = await cacheService.get(id);
    if (cached) {
      return { ...(cached as Record<string, unknown>), cached: true };
    }
  }

  const result = await queryService.executeQuery(
    widget.data_source,
    widget.entity,
    config,
    orgId,
  );

  // Store in cache using the widget's configured TTL (only the un-overridden run)
  if (cacheService && !hasOverride) {
    const ttl = widget.cache_ttl_seconds ?? undefined;
    await cacheService.set(id, result, ttl);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Force-refresh widget query (invalidate cache, then re-execute)
// ---------------------------------------------------------------------------

export async function refreshWidgetQuery(id: string, orgId: string) {
  if (cacheService) {
    await cacheService.invalidate(id);
  }
  // Re-execute without cache
  const widget = await getWidget(id);
  const result = await queryService.executeQuery(
    widget.data_source,
    widget.entity,
    widget.query_config as QueryConfig,
    orgId,
  );
  // Re-populate cache
  if (cacheService) {
    const ttl = widget.cache_ttl_seconds ?? undefined;
    await cacheService.set(id, result, ttl);
  }
  return result;
}
