import { eq, and, sql, asc, desc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { benchDashboards, benchWidgets } from '../db/schema/index.js';
import { notFound, forbidden } from '../lib/utils.js';
import type { CacheService } from '../services/cache.service.js';

// ---------------------------------------------------------------------------
// Cache singleton — set once from server.ts after Redis is ready
// ---------------------------------------------------------------------------

let cacheService: CacheService | null = null;

export function setDashboardCacheService(svc: CacheService): void {
  cacheService = svc;
}

async function invalidateWidgetsForDashboard(dashboardId: string): Promise<void> {
  if (!cacheService) return;
  const widgets = await db
    .select({ id: benchWidgets.id })
    .from(benchWidgets)
    .where(eq(benchWidgets.dashboard_id, dashboardId));
  for (const w of widgets) {
    await cacheService.invalidate(w.id);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateDashboardInput {
  name: string;
  description?: string;
  project_id?: string;
  visibility?: string;
  is_default?: boolean;
  auto_refresh_seconds?: number;
  layout?: unknown[];
}

export interface UpdateDashboardInput {
  name?: string;
  description?: string;
  project_id?: string | null;
  visibility?: string;
  is_default?: boolean;
  auto_refresh_seconds?: number | null;
  layout?: unknown[];
}

// ---------------------------------------------------------------------------
// List dashboards
// ---------------------------------------------------------------------------

export async function listDashboards(orgId: string, params: {
  project_id?: string;
  visibility?: string;
}) {
  const conditions = [eq(benchDashboards.organization_id, orgId)];

  if (params.project_id) {
    conditions.push(eq(benchDashboards.project_id, params.project_id));
  }

  if (params.visibility) {
    conditions.push(eq(benchDashboards.visibility, params.visibility));
  }

  const dashboards = await db
    .select()
    .from(benchDashboards)
    .where(and(...conditions))
    .orderBy(desc(benchDashboards.updated_at));

  // Fetch widget counts for each dashboard
  const dashIds = dashboards.map((d) => d.id);
  if (dashIds.length === 0) return [];

  const widgetCounts = await db
    .select({
      dashboard_id: benchWidgets.dashboard_id,
      count: sql<number>`count(*)::int`,
    })
    .from(benchWidgets)
    .where(inArray(benchWidgets.dashboard_id, dashIds))
    .groupBy(benchWidgets.dashboard_id);

  const countMap = new Map(widgetCounts.map((wc) => [wc.dashboard_id, wc.count]));

  return dashboards.map((d) => ({
    ...d,
    widget_count: countMap.get(d.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Get dashboard by ID (with widgets)
// ---------------------------------------------------------------------------

export async function getDashboard(id: string, orgId: string) {
  const [dashboard] = await db
    .select()
    .from(benchDashboards)
    .where(and(eq(benchDashboards.id, id), eq(benchDashboards.organization_id, orgId)))
    .limit(1);

  if (!dashboard) throw notFound('Dashboard not found');

  const widgets = await db
    .select()
    .from(benchWidgets)
    .where(eq(benchWidgets.dashboard_id, id))
    .orderBy(asc(benchWidgets.created_at));

  return { ...dashboard, widgets: orderWidgetsByLayout(widgets, dashboard.layout) };
}

/**
 * The dashboard `layout` jsonb stores the persisted widget order as an array of
 * `{ widget_id }` entries. Sort the widgets to match it; widgets not present in
 * the layout (e.g. just-created, not yet reordered) keep their creation order
 * and sort after the laid-out ones. When `layout` is empty we fall back to the
 * incoming (created_at) order untouched.
 */
function orderWidgetsByLayout<T extends { id: string }>(widgets: T[], layout: unknown): T[] {
  if (!Array.isArray(layout) || layout.length === 0) return widgets;
  const order = new Map<string, number>();
  layout.forEach((item, i) => {
    const wid = (item as { widget_id?: string })?.widget_id;
    if (typeof wid === 'string') order.set(wid, i);
  });
  if (order.size === 0) return widgets;
  return [...widgets].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.id) ? order.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

// ---------------------------------------------------------------------------
// Create dashboard
// ---------------------------------------------------------------------------

export async function createDashboard(
  input: CreateDashboardInput,
  orgId: string,
  userId: string,
) {
  // If setting as default, clear other defaults
  if (input.is_default) {
    await db
      .update(benchDashboards)
      .set({ is_default: false })
      .where(eq(benchDashboards.organization_id, orgId));
  }

  const [dashboard] = await db
    .insert(benchDashboards)
    .values({
      organization_id: orgId,
      name: input.name,
      description: input.description,
      project_id: input.project_id,
      visibility: input.visibility ?? 'private',
      is_default: input.is_default ?? false,
      auto_refresh_seconds: input.auto_refresh_seconds,
      layout: input.layout ?? [],
      created_by: userId,
      updated_by: userId,
    })
    .returning();

  return getDashboard(dashboard!.id, orgId);
}

// ---------------------------------------------------------------------------
// Update dashboard
// ---------------------------------------------------------------------------

export async function updateDashboard(
  id: string,
  orgId: string,
  userId: string,
  input: UpdateDashboardInput,
  userRole?: string,
) {
  // Ownership check: members can only edit their own dashboards
  if (userRole && userRole === 'member') {
    const [existing] = await db
      .select({ created_by: benchDashboards.created_by })
      .from(benchDashboards)
      .where(and(eq(benchDashboards.id, id), eq(benchDashboards.organization_id, orgId)))
      .limit(1);
    if (!existing) throw notFound('Dashboard not found');
    if (existing.created_by !== userId) {
      throw forbidden('Members can only edit dashboards they created');
    }
  }

  if (input.is_default) {
    await db
      .update(benchDashboards)
      .set({ is_default: false })
      .where(eq(benchDashboards.organization_id, orgId));
  }

  const updateData: Record<string, unknown> = {
    updated_by: userId,
    updated_at: new Date(),
  };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.project_id !== undefined) updateData.project_id = input.project_id;
  if (input.visibility !== undefined) updateData.visibility = input.visibility;
  if (input.is_default !== undefined) updateData.is_default = input.is_default;
  if (input.auto_refresh_seconds !== undefined) updateData.auto_refresh_seconds = input.auto_refresh_seconds;
  if (input.layout !== undefined) updateData.layout = input.layout;

  const [updated] = await db
    .update(benchDashboards)
    .set(updateData)
    .where(and(eq(benchDashboards.id, id), eq(benchDashboards.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Dashboard not found');

  // Invalidate cached query results for all widgets on this dashboard
  await invalidateWidgetsForDashboard(id);

  return getDashboard(id, orgId);
}

// ---------------------------------------------------------------------------
// Delete dashboard
// ---------------------------------------------------------------------------

export async function deleteDashboard(id: string, orgId: string, userId?: string, userRole?: string) {
  // Ownership check: members can only delete their own dashboards
  if (userRole && userRole === 'member' && userId) {
    const [existing] = await db
      .select({ created_by: benchDashboards.created_by })
      .from(benchDashboards)
      .where(and(eq(benchDashboards.id, id), eq(benchDashboards.organization_id, orgId)))
      .limit(1);
    if (!existing) throw notFound('Dashboard not found');
    if (existing.created_by !== userId) {
      throw forbidden('Members can only delete dashboards they created');
    }
  }

  // Invalidate cached query results before deletion removes widget rows
  await invalidateWidgetsForDashboard(id);
  const [deleted] = await db
    .delete(benchDashboards)
    .where(and(eq(benchDashboards.id, id), eq(benchDashboards.organization_id, orgId)))
    .returning({ id: benchDashboards.id });

  if (!deleted) throw notFound('Dashboard not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Duplicate dashboard
// ---------------------------------------------------------------------------

export async function duplicateDashboard(id: string, orgId: string, userId: string) {
  const source = await getDashboard(id, orgId);

  // Create the new dashboard
  const [dashboard] = await db
    .insert(benchDashboards)
    .values({
      organization_id: orgId,
      name: `${source.name} (Copy)`,
      description: source.description,
      project_id: source.project_id,
      visibility: 'private',
      is_default: false,
      auto_refresh_seconds: source.auto_refresh_seconds,
      layout: [],
      created_by: userId,
      updated_by: userId,
    })
    .returning();

  // Duplicate widgets
  const widgetIdMap = new Map<string, string>();
  if (source.widgets.length > 0) {
    for (const widget of source.widgets) {
      const [newWidget] = await db
        .insert(benchWidgets)
        .values({
          dashboard_id: dashboard!.id,
          name: widget.name,
          widget_type: widget.widget_type,
          data_source: widget.data_source,
          entity: widget.entity,
          query_config: widget.query_config,
          viz_config: widget.viz_config,
          kpi_config: widget.kpi_config,
          cache_ttl_seconds: widget.cache_ttl_seconds,
        })
        .returning();
      widgetIdMap.set(widget.id, newWidget!.id);
    }
  }

  // Remap layout widget IDs
  const newLayout = (source.layout as any[]).map((item: any) => ({
    ...item,
    widget_id: widgetIdMap.get(item.widget_id) ?? item.widget_id,
  }));

  await db
    .update(benchDashboards)
    .set({ layout: newLayout })
    .where(eq(benchDashboards.id, dashboard!.id));

  return getDashboard(dashboard!.id, orgId);
}
