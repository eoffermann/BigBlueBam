/**
 * Bench Data Source Registry
 *
 * Each B-product registers its queryable metrics here. This is compiled at
 * build time and ensures Bench can only query approved tables/columns.
 */

export interface MeasureDefinition {
  field: string;
  label: string;
  aggregations: ('count' | 'sum' | 'avg' | 'min' | 'max')[];
  type: 'integer' | 'numeric' | 'boolean';
}

export interface DimensionDefinition {
  field: string;
  label: string;
  type: 'categorical' | 'temporal' | 'boolean';
}

export interface FilterDefinition {
  field: string;
  label: string;
  operators: string[];
  type: 'string' | 'number' | 'date' | 'boolean' | 'enum';
  enumValues?: string[];
}

export interface JoinDefinition {
  table: string;
  alias: string;
  on: string; // SQL ON clause
  label: string;
}

export interface BenchDataSource {
  product: string;
  entity: string;
  label: string;
  description: string;
  measures: MeasureDefinition[];
  dimensions: DimensionDefinition[];
  filters: FilterDefinition[];
  baseTable: string;
  joins?: JoinDefinition[];
  /**
   * Name of the tenant-isolation column on `baseTable`. The query builder
   * always injects `<orgColumn> = $org` so a tenant can never read another
   * org's rows. Most BigBlueBam tables (bond_*, blast_*, beacon_*, and the
   * bench_mv_* materialized views) name this column `organization_id`, which
   * is the default. Bureau tables use the shorter `org_id`, so that source
   * sets `orgColumn: 'org_id'` explicitly. Any future org_id-scoped source
   * just overrides this field instead of touching query.service.ts.
   */
  orgColumn?: string;
}

/** Default tenant-isolation column when a source doesn't override `orgColumn`. */
export const DEFAULT_ORG_COLUMN = 'organization_id';

const DATA_SOURCES: BenchDataSource[] = [
  // ── Bam (Project Management) ──────────────────────────────────
  {
    product: 'bam',
    entity: 'tasks',
    label: 'Tasks',
    description: 'Bam project tasks with state, priority, and story points',
    baseTable: 'tasks',
    // The tasks table isolates by `org_id` (not the default `organization_id`),
    // and uses `state_id` (FK to task_states), not a `state` enum column. There
    // is no `task_type` column. The prior declaration 500'd every bam.tasks
    // query (PostgresError 42703) — see fix in this commit.
    orgColumn: 'org_id',
    measures: [
      { field: 'id', label: 'Task Count', aggregations: ['count'], type: 'integer' },
      { field: 'story_points', label: 'Story Points', aggregations: ['sum', 'avg', 'min', 'max'], type: 'integer' },
    ],
    dimensions: [
      { field: 'state_id', label: 'State', type: 'categorical' },
      { field: 'priority', label: 'Priority', type: 'categorical' },
      { field: 'phase_id', label: 'Phase', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
      { field: 'updated_at', label: 'Updated', type: 'temporal' },
      { field: 'project_id', label: 'Project', type: 'categorical' },
      { field: 'assignee_id', label: 'Assignee', type: 'categorical' },
    ],
    filters: [
      { field: 'state_id', label: 'State', operators: ['eq', 'neq', 'in'], type: 'string' },
      { field: 'priority', label: 'Priority', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['critical', 'urgent', 'high', 'medium', 'low', 'none'] },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
      { field: 'project_id', label: 'Project', operators: ['eq', 'in'], type: 'string' },
    ],
  },

  // ── Bond (CRM) ────────────────────────────────────────────────
  {
    product: 'bond',
    entity: 'deals',
    label: 'Deals',
    description: 'Bond CRM deals with value, stage, and pipeline data',
    baseTable: 'bond_deals',
    measures: [
      { field: 'id', label: 'Deal Count', aggregations: ['count'], type: 'integer' },
      { field: 'value', label: 'Deal Value', aggregations: ['sum', 'avg', 'min', 'max'], type: 'numeric' },
      { field: 'weighted_value', label: 'Weighted Value', aggregations: ['sum', 'avg'], type: 'numeric' },
    ],
    dimensions: [
      { field: 'stage_id', label: 'Stage', type: 'categorical' },
      { field: 'pipeline_id', label: 'Pipeline', type: 'categorical' },
      { field: 'owner_id', label: 'Owner', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
      { field: 'closed_at', label: 'Closed', type: 'temporal' },
    ],
    filters: [
      { field: 'pipeline_id', label: 'Pipeline', operators: ['eq', 'in'], type: 'string' },
      { field: 'closed_at', label: 'Closed', operators: ['is_null', 'is_not_null', 'gte', 'lte'], type: 'date' },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },
  {
    product: 'bond',
    entity: 'contacts',
    label: 'Contacts',
    description: 'Bond CRM contacts with lifecycle and lead scoring',
    baseTable: 'bond_contacts',
    measures: [
      { field: 'id', label: 'Contact Count', aggregations: ['count'], type: 'integer' },
      { field: 'lead_score', label: 'Lead Score', aggregations: ['sum', 'avg', 'min', 'max'], type: 'integer' },
    ],
    dimensions: [
      { field: 'lifecycle_stage', label: 'Lifecycle Stage', type: 'categorical' },
      { field: 'lead_source', label: 'Lead Source', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
    ],
    filters: [
      { field: 'lifecycle_stage', label: 'Lifecycle Stage', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['subscriber', 'lead', 'marketing_qualified', 'sales_qualified', 'opportunity', 'customer', 'evangelist', 'other'] },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },

  // ── Blast (Email Campaigns) ───────────────────────────────────
  {
    product: 'blast',
    entity: 'campaigns',
    label: 'Campaigns',
    description: 'Blast email campaigns with delivery and engagement metrics',
    baseTable: 'blast_campaigns',
    measures: [
      { field: 'id', label: 'Campaign Count', aggregations: ['count'], type: 'integer' },
      { field: 'total_sent', label: 'Total Sent', aggregations: ['sum', 'avg'], type: 'integer' },
      { field: 'total_opened', label: 'Total Opened', aggregations: ['sum', 'avg'], type: 'integer' },
      { field: 'total_clicked', label: 'Total Clicked', aggregations: ['sum', 'avg'], type: 'integer' },
    ],
    dimensions: [
      { field: 'status', label: 'Status', type: 'categorical' },
      { field: 'sent_at', label: 'Sent At', type: 'temporal' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
    ],
    filters: [
      { field: 'status', label: 'Status', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled'] },
      { field: 'sent_at', label: 'Sent', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },

  // ── Helpdesk ──────────────────────────────────────────────────
  {
    product: 'helpdesk',
    entity: 'tickets',
    label: 'Tickets',
    description: 'Helpdesk support tickets with priority and status',
    baseTable: 'tickets',
    measures: [
      { field: 'id', label: 'Ticket Count', aggregations: ['count'], type: 'integer' },
    ],
    dimensions: [
      { field: 'status', label: 'Status', type: 'categorical' },
      { field: 'priority', label: 'Priority', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
      { field: 'resolved_at', label: 'Resolved', type: 'temporal' },
    ],
    filters: [
      { field: 'status', label: 'Status', operators: ['eq', 'neq', 'in'], type: 'string' },
      { field: 'priority', label: 'Priority', operators: ['eq', 'neq', 'in'], type: 'string' },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },

  // ── Beacon (Knowledge Base) ────────────────────────────────────
  {
    product: 'beacon',
    entity: 'articles',
    label: 'Knowledge Base Articles',
    description: 'Beacon knowledge base entries with status, visibility, and verification tracking',
    baseTable: 'beacon_entries',
    measures: [
      { field: 'id', label: 'Article Count', aggregations: ['count'], type: 'integer' },
      { field: 'version', label: 'Version', aggregations: ['avg', 'max'], type: 'integer' },
      { field: 'verification_count', label: 'Verification Count', aggregations: ['sum', 'avg', 'max'], type: 'integer' },
    ],
    dimensions: [
      { field: 'status', label: 'Status', type: 'categorical' },
      { field: 'visibility', label: 'Visibility', type: 'categorical' },
      { field: 'project_id', label: 'Project', type: 'categorical' },
      { field: 'owned_by', label: 'Owner', type: 'categorical' },
      { field: 'created_by', label: 'Author', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
      { field: 'updated_at', label: 'Updated', type: 'temporal' },
      { field: 'expires_at', label: 'Expires', type: 'temporal' },
    ],
    filters: [
      { field: 'status', label: 'Status', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['Draft', 'Active', 'Under Review', 'Retired'] },
      { field: 'visibility', label: 'Visibility', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['Public', 'Organization', 'Project', 'Private'] },
      { field: 'project_id', label: 'Project', operators: ['eq', 'in', 'is_null', 'is_not_null'], type: 'string' },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
      { field: 'expires_at', label: 'Expires', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },

  // ── Bearing (Goals & OKRs) ────────────────────────────────────
  {
    product: 'bearing',
    entity: 'goals',
    label: 'Goals',
    description: 'Bearing OKR goals with status, progress, and period tracking',
    baseTable: 'bearing_goals',
    measures: [
      { field: 'id', label: 'Goal Count', aggregations: ['count'], type: 'integer' },
      { field: 'progress', label: 'Progress', aggregations: ['avg', 'min', 'max'], type: 'numeric' },
    ],
    dimensions: [
      { field: 'status', label: 'Status', type: 'categorical' },
      { field: 'scope', label: 'Scope', type: 'categorical' },
      { field: 'period_id', label: 'Period', type: 'categorical' },
      { field: 'project_id', label: 'Project', type: 'categorical' },
      { field: 'team_name', label: 'Team', type: 'categorical' },
      { field: 'owner_id', label: 'Owner', type: 'categorical' },
      { field: 'created_at', label: 'Created', type: 'temporal' },
      { field: 'updated_at', label: 'Updated', type: 'temporal' },
    ],
    filters: [
      { field: 'status', label: 'Status', operators: ['eq', 'neq', 'in'], type: 'enum', enumValues: ['draft', 'active', 'at_risk', 'behind', 'on_track', 'completed', 'cancelled'] },
      { field: 'scope', label: 'Scope', operators: ['eq', 'in'], type: 'enum', enumValues: ['organization', 'team', 'project', 'individual'] },
      { field: 'period_id', label: 'Period', operators: ['eq', 'in'], type: 'string' },
      { field: 'project_id', label: 'Project', operators: ['eq', 'in', 'is_null', 'is_not_null'], type: 'string' },
      { field: 'created_at', label: 'Created', operators: ['gte', 'lte', 'between'], type: 'date' },
      { field: 'progress', label: 'Progress', operators: ['gte', 'lte', 'between'], type: 'number' },
    ],
  },

  // ── Bureau (Spatial presence) ─────────────────────────────────
  //
  // IMPORTANT (reviewers): `bureau_floor_analytics` is a NIGHTLY ROLLUP, not a
  // live feed. The `bureau.analytics.rollup` BullMQ worker writes one row per
  // (floor, day) at midnight UTC for the *previous* day, so any activity a user
  // does today (summons, knocks, bookings) only shows up in this source
  // tomorrow. A 1-day window is therefore usually blank mid-day — widgets here
  // should use a forgiving window (last_7_days). Real-time counters are NOT
  // served from this table: subscribe to the `bureau.summon.issued` Bolt event
  // instead. Do not "fix" the latency here; it is by design.
  //
  // Tenant column note: every bureau_* table (incl. this one, migration 0176)
  // uses `org_id`, NOT `organization_id`. That's why `orgColumn` is overridden
  // below — without it the query builder would emit `organization_id = $1` and
  // every Bureau widget would 42703 ("column does not exist") and return nothing.
  {
    product: 'bureau',
    entity: 'floor_analytics',
    label: 'Bureau Floor Analytics (Daily)',
    description: 'Daily per-floor utilization rollup: peak occupancy, summons, knocks, bookings. Written nightly by the bureau.analytics.rollup worker.',
    baseTable: 'bureau_floor_analytics',
    orgColumn: 'org_id',
    measures: [
      { field: 'peak_occupancy', label: 'Peak Occupancy', aggregations: ['max', 'avg', 'sum'], type: 'integer' },
      { field: 'summon_count', label: 'Summons', aggregations: ['sum', 'avg', 'max'], type: 'integer' },
      { field: 'knock_count', label: 'Knocks', aggregations: ['sum', 'avg', 'max'], type: 'integer' },
      { field: 'booking_count', label: 'Bookings', aggregations: ['sum', 'avg', 'max'], type: 'integer' },
    ],
    dimensions: [
      { field: 'floor_id', label: 'Floor', type: 'categorical' },
      { field: 'day', label: 'Day', type: 'temporal' },
    ],
    filters: [
      { field: 'floor_id', label: 'Floor', operators: ['eq', 'in'], type: 'string' },
      { field: 'day', label: 'Day', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },

  // ── Materialized views (cross-product) ────────────────────────
  {
    product: 'bench',
    entity: 'daily_task_throughput',
    label: 'Daily Task Throughput',
    description: 'Pre-computed daily task throughput by project',
    baseTable: 'bench_mv_daily_task_throughput',
    // NOTE: the measure fields below match the actual MV columns (total_tasks /
    // with_state / total_points — see infra/postgres/migrations/0035_bench_tables.sql),
    // not the historical completed/in_progress/points_completed names which never
    // existed on the view. ⚠ This MV is still NOT org-isolated: it has no
    // organization_id column (it groups by project_id only), so the query builder's
    // mandatory `organization_id = $org` filter 42703s against it. Until a migration
    // rebuilds the MV with an organization_id column, widgets cannot use this source;
    // the "Daily Task Throughput" gallery preset queries bam.tasks directly instead.
    measures: [
      { field: 'total_tasks', label: 'Total Tasks', aggregations: ['sum', 'avg'], type: 'integer' },
      { field: 'with_state', label: 'Tasks With State', aggregations: ['sum', 'avg'], type: 'integer' },
      { field: 'total_points', label: 'Total Points', aggregations: ['sum', 'avg'], type: 'integer' },
    ],
    dimensions: [
      { field: 'project_id', label: 'Project', type: 'categorical' },
      { field: 'day', label: 'Day', type: 'temporal' },
    ],
    filters: [
      { field: 'project_id', label: 'Project', operators: ['eq', 'in'], type: 'string' },
      { field: 'day', label: 'Day', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },
  {
    product: 'bench',
    entity: 'pipeline_snapshot',
    label: 'Pipeline Snapshot',
    description: 'Pre-computed pipeline value by stage (Bond)',
    baseTable: 'bench_mv_pipeline_snapshot',
    measures: [
      { field: 'deal_count', label: 'Deal Count', aggregations: ['sum'], type: 'integer' },
      { field: 'total_value', label: 'Total Value', aggregations: ['sum'], type: 'numeric' },
      { field: 'weighted_value', label: 'Weighted Value', aggregations: ['sum'], type: 'numeric' },
    ],
    dimensions: [
      { field: 'stage_name', label: 'Stage', type: 'categorical' },
      { field: 'stage_type', label: 'Stage Type', type: 'categorical' },
      { field: 'pipeline_id', label: 'Pipeline', type: 'categorical' },
    ],
    filters: [
      { field: 'pipeline_id', label: 'Pipeline', operators: ['eq', 'in'], type: 'string' },
      { field: 'organization_id', label: 'Organization', operators: ['eq'], type: 'string' },
    ],
  },
  {
    product: 'bench',
    entity: 'campaign_engagement',
    label: 'Campaign Engagement',
    description: 'Pre-computed email campaign engagement rates (Blast)',
    baseTable: 'bench_mv_campaign_engagement',
    measures: [
      { field: 'total_sent', label: 'Sent', aggregations: ['sum'], type: 'integer' },
      { field: 'total_opened', label: 'Opened', aggregations: ['sum'], type: 'integer' },
      { field: 'total_clicked', label: 'Clicked', aggregations: ['sum'], type: 'integer' },
      { field: 'open_rate', label: 'Open Rate', aggregations: ['avg'], type: 'numeric' },
      { field: 'click_rate', label: 'Click Rate', aggregations: ['avg'], type: 'numeric' },
    ],
    dimensions: [
      { field: 'name', label: 'Campaign Name', type: 'categorical' },
      { field: 'sent_at', label: 'Sent At', type: 'temporal' },
    ],
    filters: [
      { field: 'organization_id', label: 'Organization', operators: ['eq'], type: 'string' },
      { field: 'sent_at', label: 'Sent', operators: ['gte', 'lte', 'between'], type: 'date' },
    ],
  },
];

const sourceMap = new Map<string, BenchDataSource>();
for (const ds of DATA_SOURCES) {
  sourceMap.set(`${ds.product}:${ds.entity}`, ds);
}

export function listDataSources(): BenchDataSource[] {
  return DATA_SOURCES;
}

export function getDataSource(product: string, entity: string): BenchDataSource | undefined {
  return sourceMap.get(`${product}:${entity}`);
}

export function listDataSourcesByProduct(product: string): BenchDataSource[] {
  return DATA_SOURCES.filter((ds) => ds.product === product);
}
