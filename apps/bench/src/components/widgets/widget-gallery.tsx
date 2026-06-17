import { useState } from 'react';
import { BarChart3, LineChart, PieChart, Hash, TrendingUp, Layers, Target, Users, Zap, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface WidgetPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  widget_type: string;
  data_source: string;
  entity: string;
  query_config: Record<string, unknown>;
  viz_config: Record<string, unknown>;
  kpi_config?: Record<string, unknown>;
}

const WIDGET_PRESETS: WidgetPreset[] = [
  // Bam project management
  {
    id: 'bam_sprint_velocity',
    name: 'Sprint Velocity',
    description: 'Track story points completed per sprint over time.',
    category: 'Project Management',
    widget_type: 'bar_chart',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'story_points', agg: 'sum', alias: 'total_points' }],
      dimensions: [{ field: 'sprint_id', alias: 'sprint' }],
      date_range: { preset: 'last_90_days' },
    },
    viz_config: { stacked: false },
  },
  {
    id: 'bam_tasks_by_state',
    name: 'Tasks by State',
    description: 'Distribution of tasks across workflow states.',
    category: 'Project Management',
    widget_type: 'donut_chart',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'count' }],
      dimensions: [{ field: 'state_id', alias: 'state' }],
    },
    viz_config: {},
  },
  {
    id: 'bam_task_count',
    name: 'Total Open Tasks',
    description: 'Count of all non-completed tasks.',
    category: 'Project Management',
    widget_type: 'kpi_card',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'open_tasks' }],
      dimensions: [],
    },
    viz_config: {},
    kpi_config: { suffix: 'tasks' },
  },
  {
    id: 'bam_tasks_by_priority',
    name: 'Tasks by Priority',
    description: 'Bar chart showing task count for each priority level.',
    category: 'Project Management',
    widget_type: 'bar_chart',
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'count' }],
      dimensions: [{ field: 'priority', alias: 'priority' }],
    },
    viz_config: {},
  },

  // Bond CRM
  {
    id: 'bond_pipeline_value',
    name: 'Pipeline Value',
    description: 'Total value of all open deals in the pipeline.',
    category: 'CRM',
    widget_type: 'kpi_card',
    data_source: 'bond',
    entity: 'deals',
    query_config: {
      measures: [{ field: 'value', agg: 'sum', alias: 'total_value' }],
      dimensions: [],
    },
    viz_config: {},
    kpi_config: { format: 'currency', prefix: '$' },
  },
  {
    id: 'bond_deals_by_stage',
    name: 'Deals by Stage',
    description: 'Distribution of deals across pipeline stages.',
    category: 'CRM',
    widget_type: 'bar_chart',
    data_source: 'bond',
    entity: 'deals',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'deal_count' }, { field: 'value', agg: 'sum', alias: 'total_value' }],
      dimensions: [{ field: 'stage_id', alias: 'stage' }],
    },
    viz_config: {},
  },
  {
    id: 'bond_pipeline_funnel',
    name: 'Pipeline Funnel',
    description: 'Funnel visualization of deals through pipeline stages.',
    category: 'CRM',
    widget_type: 'funnel',
    data_source: 'bond',
    entity: 'deals',
    query_config: {
      measures: [{ field: 'value', agg: 'sum', alias: 'value' }],
      dimensions: [{ field: 'stage_id', alias: 'stage' }],
    },
    viz_config: {},
  },

  // Blast email
  {
    id: 'blast_open_rate',
    name: 'Total Opens',
    description: 'Total email opens across all campaigns.',
    category: 'Email Marketing',
    widget_type: 'kpi_card',
    data_source: 'blast',
    entity: 'campaigns',
    // The blast.campaigns source exposes count totals (total_opened/total_clicked/
    // total_sent), not pre-computed rate columns — open_rate/click_rate live only
    // on the bench_mv_campaign_engagement MV, which this base-table source can't read.
    query_config: {
      measures: [{ field: 'total_opened', agg: 'sum', alias: 'total_opens' }],
      dimensions: [],
    },
    viz_config: {},
    kpi_config: { suffix: 'opens' },
  },
  {
    id: 'blast_engagement_trend',
    name: 'Engagement Trend',
    description: 'Opens and clicks over time for sent campaigns.',
    category: 'Email Marketing',
    widget_type: 'line_chart',
    data_source: 'blast',
    entity: 'campaigns',
    query_config: {
      measures: [
        { field: 'total_opened', agg: 'sum', alias: 'opens' },
        { field: 'total_clicked', agg: 'sum', alias: 'clicks' },
      ],
      dimensions: [{ field: 'sent_at', alias: 'date' }],
      date_range: { preset: 'last_90_days' },
    },
    viz_config: {},
  },

  // Helpdesk
  {
    id: 'helpdesk_open_tickets',
    name: 'Open Tickets',
    description: 'Count of unresolved helpdesk tickets.',
    category: 'Support',
    widget_type: 'kpi_card',
    data_source: 'helpdesk',
    entity: 'tickets',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'open_tickets' }],
      dimensions: [],
    },
    viz_config: {},
    kpi_config: { suffix: 'tickets' },
  },
  {
    id: 'helpdesk_by_priority',
    name: 'Tickets by Priority',
    description: 'Distribution of tickets by priority level.',
    category: 'Support',
    widget_type: 'pie_chart',
    data_source: 'helpdesk',
    entity: 'tickets',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'count' }],
      dimensions: [{ field: 'priority', alias: 'priority' }],
    },
    viz_config: {},
  },

  // Cross-product
  {
    id: 'mv_daily_throughput',
    name: 'Daily Task Throughput',
    description: 'Tasks created per day across projects, bucketed daily.',
    category: 'Cross-Product',
    widget_type: 'area_chart',
    // The bench:daily_task_throughput materialized-view source is not org-isolated
    // (the MV has no organization_id column) and declares measure fields that do
    // not exist on the view, so it cannot back a working widget. We instead query
    // the live bam.tasks source with a daily time bucket, which preserves the
    // "tasks per day" intent and instantiates cleanly.
    data_source: 'bam',
    entity: 'tasks',
    query_config: {
      measures: [{ field: 'id', agg: 'count', alias: 'tasks' }],
      time_dimension: { field: 'created_at', granularity: 'day' },
      date_range: { preset: 'last_30_days' },
    },
    viz_config: {},
  },
];

const CATEGORIES = ['All', ...Array.from(new Set(WIDGET_PRESETS.map((p) => p.category)))];

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  'Project Management': Layers,
  'CRM': Target,
  'Email Marketing': Zap,
  'Support': Users,
  'Cross-Product': TrendingUp,
};

const TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  bar_chart: BarChart3,
  line_chart: LineChart,
  area_chart: TrendingUp,
  pie_chart: PieChart,
  donut_chart: PieChart,
  kpi_card: Hash,
  counter: Hash,
  funnel: Filter,
  table: Layers,
};

interface WidgetGalleryProps {
  onSelect: (preset: WidgetPreset) => void;
  onClose: () => void;
}

export function WidgetGallery({ onSelect, onClose }: WidgetGalleryProps) {
  const [category, setCategory] = useState('All');

  const filtered = category === 'All'
    ? WIDGET_PRESETS
    : WIDGET_PRESETS.filter((p) => p.category === category);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Widget Templates</h2>
        <button
          onClick={onClose}
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Close
        </button>
      </div>

      {/* Category filter */}
      <div className="flex gap-1.5 flex-wrap">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={cn(
              'px-3 py-1 text-xs font-medium rounded-full transition-colors',
              category === cat
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700',
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Preset grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((preset) => {
          const TypeIcon = TYPE_ICONS[preset.widget_type] ?? BarChart3;
          const CatIcon = CATEGORY_ICONS[preset.category] ?? Layers;
          return (
            <button
              key={preset.id}
              onClick={() => onSelect(preset)}
              className="text-left p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 hover:border-primary-300 dark:hover:border-primary-700 hover:shadow-sm transition-all group"
            >
              <div className="flex items-center gap-2 mb-2">
                <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 group-hover:bg-primary-50 group-hover:text-primary-600 dark:group-hover:bg-primary-900/30 dark:group-hover:text-primary-400 transition-colors">
                  <TypeIcon className="h-4 w-4" />
                </div>
                <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-700 rounded px-1.5 py-0.5">
                  {preset.widget_type.replace('_', ' ')}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{preset.name}</h3>
              <p className="text-xs text-zinc-500 mt-1 line-clamp-2">{preset.description}</p>
              <div className="flex items-center gap-1 mt-2 text-[10px] text-zinc-400">
                <CatIcon className="h-3 w-3" />
                {preset.category}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { WIDGET_PRESETS };
