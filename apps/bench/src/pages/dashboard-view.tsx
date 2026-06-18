import { useState, useEffect } from 'react';
import { Edit2, RefreshCw, Maximize2, Clock } from 'lucide-react';
import { useDashboard } from '@/hooks/use-dashboards';
import { useWidgetQuery, type WidgetQueryDateRange } from '@/hooks/use-widgets';
import { ChartRenderer } from '@/components/widgets/chart-renderer';
import { DateRangePicker, type DateRange } from '@/components/dashboards/date-range-picker';

interface DashboardViewPageProps {
  dashboardId: string;
  onNavigate: (path: string) => void;
}

/**
 * Map the picker's DateRange ({ preset, from, to }) onto the API's expected
 * shape ({ preset, start, end }). Returns undefined when nothing is selected so
 * widgets run their own saved range.
 */
function toQueryDateRange(range: DateRange): WidgetQueryDateRange | undefined {
  if (range.preset) return { preset: range.preset };
  if (range.from || range.to) return { start: range.from, end: range.to };
  return undefined;
}

function WidgetCard({ widget, dateRange }: { widget: any; dateRange?: WidgetQueryDateRange }) {
  const { data, isLoading } = useWidgetQuery(widget.id, dateRange);
  const queryResult = data?.data;

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{widget.name}</h4>
        <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-700 rounded px-1.5 py-0.5">{widget.widget_type.replace('_', ' ')}</span>
      </div>
      <div className="flex-1 flex items-center justify-center min-h-[120px]">
        {isLoading ? (
          <div className="text-sm text-zinc-400">Loading...</div>
        ) : (
          <div className="w-full">
            <ChartRenderer
              widgetType={widget.widget_type}
              data={queryResult?.rows ?? []}
              vizConfig={widget.viz_config}
              kpiConfig={widget.kpi_config}
              widgetName={widget.name}
            />
          </div>
        )}
      </div>
      {queryResult?.duration_ms != null && (
        <div className="flex items-center gap-1 mt-2 text-[10px] text-zinc-400">
          <Clock className="h-3 w-3" />
          {queryResult.duration_ms}ms
        </div>
      )}
    </div>
  );
}

export function DashboardViewPage({ dashboardId, onNavigate }: DashboardViewPageProps) {
  const { data, isLoading, refetch } = useDashboard(dashboardId);
  const dashboard = data?.data;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({});
  const queryDateRange = toQueryDateRange(dateRange);

  // Auto-refresh
  useEffect(() => {
    if (!dashboard?.auto_refresh_seconds) return;
    const interval = setInterval(() => refetch(), dashboard.auto_refresh_seconds * 1000);
    return () => clearInterval(interval);
  }, [dashboard?.auto_refresh_seconds, refetch]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="h-8 w-48 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-48 bg-zinc-100 dark:bg-zinc-800 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="p-6 text-center text-zinc-500">Dashboard not found.</div>
    );
  }

  return (
    <div className={`p-6 ${isFullscreen ? 'fixed inset-0 z-40 bg-white dark:bg-zinc-900 overflow-auto' : ''}`}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{dashboard.name}</h1>
          {dashboard.description && (
            <p className="text-sm text-zinc-500 mt-0.5">{dashboard.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <button
            onClick={() => refetch()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onNavigate(`/dashboards/${dashboardId}/edit`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            <Edit2 className="h-3.5 w-3.5" />
            Edit
          </button>
        </div>
      </div>

      {dashboard.widgets && dashboard.widgets.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {dashboard.widgets.map((widget: any) => (
            <WidgetCard key={widget.id} widget={widget} dateRange={queryDateRange} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 text-zinc-500">
          <p>This dashboard has no widgets yet.</p>
          <button
            onClick={() => onNavigate(`/dashboards/${dashboardId}/edit`)}
            className="mt-3 text-sm text-primary-600 hover:text-primary-700"
          >
            Add widgets
          </button>
        </div>
      )}
    </div>
  );
}
