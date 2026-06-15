import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Bookmark, Plus, Trash2, Eye } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { api } from '@/lib/api';

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string | undefined>;
  view_type: string;
  // The board persists swimlane grouping and lane sort as part of a view, so a
  // saved view round-trips them too (matches saved_views.swimlane / .sort).
  swimlane?: string | null;
  sort?: string | null;
  created_at: string;
}

interface SavedViewsPanelProps {
  projectId: string;
  currentFilters: Record<string, string | undefined>;
  currentViewType: string;
  currentSwimlane: string;
  currentSort: string;
  onApplyView: (view: SavedView) => void;
}

export function SavedViewsPanel({
  projectId,
  currentFilters,
  currentViewType,
  currentSwimlane,
  currentSort,
  onApplyView,
}: SavedViewsPanelProps) {
  const queryClient = useQueryClient();
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [viewName, setViewName] = useState('');

  const { data: viewsRes, isLoading } = useQuery({
    queryKey: ['saved-views', projectId],
    queryFn: () => api.get<{ data: SavedView[] }>(`/projects/${projectId}/views`),
    enabled: !!projectId,
  });
  const views = viewsRes?.data ?? [];

  const createView = useMutation({
    mutationFn: (data: {
      name: string;
      filters: Record<string, string | undefined>;
      view_type: string;
      swimlane?: string;
      sort?: string;
    }) => api.post(`/projects/${projectId}/views`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-views', projectId] });
      setShowSaveForm(false);
      setViewName('');
    },
  });

  // The DELETE route is /views/:id (NOT project-scoped like GET/POST). The old
  // /projects/:id/views/:viewId path 404'd, so the delete silently did nothing.
  const deleteView = useMutation({
    mutationFn: (viewId: string) => api.delete(`/views/${viewId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-views', projectId] });
    },
  });

  const handleSave = () => {
    if (!viewName.trim()) return;
    createView.mutate({
      name: viewName.trim(),
      filters: currentFilters,
      view_type: currentViewType,
      // Persist the full view so applying it later restores grouping + sort.
      swimlane: currentSwimlane,
      sort: currentSort,
    });
  };

  return (
    <div className="w-64 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
          <Bookmark className="h-4 w-4" />
          Saved Views
        </h3>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {views.length > 0 ? (
            views.map((view) => (
              <div
                key={view.id}
                className="group flex items-center gap-2 p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-primary-300 dark:hover:border-primary-700 transition-colors"
              >
                <button
                  className="flex-1 text-left min-w-0"
                  onClick={() => onApplyView(view)}
                >
                  <div className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">
                      {view.name}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-0.5 capitalize">
                    {view.view_type} view
                  </p>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteView.mutate(view.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 rounded hover:bg-red-50 dark:hover:bg-red-950 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  title="Delete view"
                  aria-label={`Delete view ${view.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
                </button>
              </div>
            ))
          ) : (
            <p className="text-xs text-zinc-400 text-center py-4">
              No saved views yet
            </p>
          )}
        </div>
      )}

      {/* Save current view */}
      {showSaveForm ? (
        <div className="space-y-2 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
          <Input
            id="view-name"
            placeholder="View name..."
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowSaveForm(false);
                setViewName('');
              }}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              loading={createView.isPending}
              disabled={!viewName.trim()}
              className="flex-1"
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowSaveForm(true)}
          className="w-full"
        >
          <Plus className="h-4 w-4" />
          Save Current View
        </Button>
      )}
    </div>
  );
}
