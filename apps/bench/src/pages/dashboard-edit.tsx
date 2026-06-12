import { useState } from 'react';
import { Plus, Save, ArrowLeft, Trash2, GripVertical, Sparkles } from 'lucide-react';
import { useDashboard, useUpdateDashboard } from '@/hooks/use-dashboards';
import { useDeleteWidget, useCreateWidget } from '@/hooks/use-widgets';
import { WidgetGallery, type WidgetPreset } from '@/components/widgets/widget-gallery';
import { useBureauLocationLabel } from '@bigbluebam/bureau-client';

interface DashboardEditPageProps {
  dashboardId: string;
  onNavigate: (path: string) => void;
}

export function DashboardEditPage({ dashboardId, onNavigate }: DashboardEditPageProps) {
  const { data, isLoading } = useDashboard(dashboardId);
  const updateMutation = useUpdateDashboard(dashboardId);
  const deleteWidgetMutation = useDeleteWidget();
  const createWidget = useCreateWidget(dashboardId);
  const dashboard = data?.data;
  // Bureau widget context: show the dashboard name, not the URL path.
  useBureauLocationLabel(dashboard?.name ?? null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('private');
  const [initialized, setInitialized] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  if (dashboard && !initialized) {
    setName(dashboard.name);
    setDescription(dashboard.description ?? '');
    setVisibility(dashboard.visibility);
    setInitialized(true);
  }

  const handleSave = async () => {
    await updateMutation.mutateAsync({ name, description, visibility });
  };

  if (isLoading) {
    return <div className="p-6"><div className="h-8 w-48 bg-zinc-200 dark:bg-zinc-700 rounded animate-pulse" /></div>;
  }

  if (!dashboard) {
    return <div className="p-6 text-center text-zinc-500">Dashboard not found.</div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate(`/dashboards/${dashboardId}`)}
            className="p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Edit Dashboard</h1>
        </div>
        <button
          onClick={handleSave}
          disabled={updateMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm font-medium disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          Save
        </button>
      </div>

      {/* Metadata */}
      <div className="space-y-4 mb-8">
        <div>
          <label htmlFor="bench-dashboard-name" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Name</label>
          <input
            id="bench-dashboard-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
        </div>
        <div>
          <label htmlFor="bench-dashboard-description" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Description</label>
          <textarea
            id="bench-dashboard-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-primary-500 outline-none resize-none"
          />
        </div>
        <div>
          <label htmlFor="bench-dashboard-visibility" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Visibility</label>
          <select
            id="bench-dashboard-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            className="px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          >
            <option value="private">Private</option>
            <option value="project">Project</option>
            <option value="organization">Organization</option>
          </select>
        </div>
      </div>

      {/* Widgets */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Widgets</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGallery(!showGallery)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Templates
          </button>
          <button
            onClick={() => onNavigate(`/dashboards/${dashboardId}/widgets/new`)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Custom Widget
          </button>
        </div>
      </div>

      {/* Widget Gallery */}
      {showGallery && (
        <div className="mb-6 border border-zinc-200 dark:border-zinc-700 rounded-xl p-5 bg-zinc-50 dark:bg-zinc-800/30">
          <WidgetGallery
            onSelect={async (preset: WidgetPreset) => {
              await createWidget.mutateAsync({
                name: preset.name,
                widget_type: preset.widget_type,
                data_source: preset.data_source,
                entity: preset.entity,
                query_config: preset.query_config,
                viz_config: preset.viz_config,
                kpi_config: preset.kpi_config ?? null,
              });
              setShowGallery(false);
            }}
            onClose={() => setShowGallery(false)}
          />
        </div>
      )}

      {dashboard.widgets && dashboard.widgets.length > 0 ? (
        <div className="space-y-2">
          {dashboard.widgets.map((widget: any) => (
            <div
              key={widget.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50"
            >
              <GripVertical className="h-4 w-4 text-zinc-300 dark:text-zinc-600 cursor-grab" />
              <div className="flex-1">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{widget.name}</div>
                <div className="text-xs text-zinc-500">{widget.data_source} / {widget.entity} - {widget.widget_type.replace('_', ' ')}</div>
              </div>
              <button
                onClick={() => onNavigate(`/widgets/${widget.id}/edit`)}
                className="text-xs text-primary-600 hover:text-primary-700"
              >
                Edit
              </button>
              <button
                onClick={() => deleteWidgetMutation.mutate(widget.id)}
                className="text-zinc-400 hover:text-red-500 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No widgets yet. Click "Add Widget" to get started.
        </div>
      )}
    </div>
  );
}
