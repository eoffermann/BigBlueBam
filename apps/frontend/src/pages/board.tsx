import { useState, useEffect, useCallback, useMemo } from 'react';
import { Loader2, Upload, BarChart3, Bookmark, FileText, Layers, Trash2, MoreVertical, Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { Task, PaginatedResponse } from '@bigbluebam/shared';
import { AppLayout } from '@/components/layout/app-layout';
import { BoardView } from '@/components/board/board-view';
import { SwimlaneBoard, type SwimlanGroupBy } from '@/components/board/swimlane-board';
import { SprintSelector } from '@/components/board/sprint-selector';
import { FilterBar } from '@/components/board/filter-bar';
import { ViewSwitcher, type ViewMode } from '@/components/board/view-switcher';
import { SavedViewsPanel } from '@/components/board/saved-views-panel';
import { ListView } from '@/components/views/list-view';
import { TimelineView } from '@/components/views/timeline-view';
import { CalendarView } from '@/components/views/calendar-view';
import { WorkloadView } from '@/components/views/workload-view';
import { TaskDetailDrawer } from '@/components/tasks/task-detail-drawer';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { ImportDialog } from '@/components/import/import-dialog';
import { TemplateManager } from '@/components/tasks/template-manager';
import { EpicManager } from '@/components/board/epic-manager';
import { PhaseManager } from '@/components/board/phase-manager';
import { CustomFieldManager } from '@/components/board/custom-field-manager';
import { KeyboardShortcutsOverlay } from '@/components/common/keyboard-shortcuts-overlay';
import { CommandPalette } from '@/components/common/command-palette';
import { Select } from '@/components/common/select';
import { Button } from '@/components/common/button';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useBoard, useCreateTask, useUpdateTask, useDeleteTask } from '@/hooks/use-tasks';
import { useSprints } from '@/hooks/use-sprints';
import { useProject, useProjects, useDeleteProject } from '@/hooks/use-projects';
import { useBoardStore } from '@/stores/board.store';
import { useRealtime } from '@/hooks/use-realtime';
import { api, ApiError } from '@/lib/api';

interface Member {
  id: string;
  display_name: string;
  avatar_url: string | null;
  role: string;
}

interface BoardPageProps {
  projectId: string;
  onNavigate: (path: string) => void;
}

const SWIMLANE_OPTIONS = [
  { value: 'none', label: 'No Swimlanes' },
  { value: 'assignee', label: 'By Assignee' },
  { value: 'priority', label: 'By Priority' },
  { value: 'epic', label: 'By Epic' },
];

export function BoardPage({ projectId, onNavigate }: BoardPageProps) {
  const [selectedSprintId, setSelectedSprintId] = useState<string | undefined>();
  // Initial task selection honors a `?task=<uuid>` query param so external
  // links (Banter "MAGE-38" refs, email links, etc.) can deep-link into a
  // specific task's drawer on first load. The param is consumed once then
  // cleared from the URL to keep subsequent navigation clean.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const taskParam = new URLSearchParams(window.location.search).get('task');
    return taskParam && /^[0-9a-f]{8}-/i.test(taskParam) ? taskParam : null;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('task')) {
      url.searchParams.delete('task');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createDialogPhaseId, setCreateDialogPhaseId] = useState<string | undefined>();
  const [filters, setFilters] = useState<{ assignee_id?: string; priority?: string; state_id?: string; search?: string }>({});
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [swimlaneGroupBy, setSwimlaneGroupBy] = useState<SwimlanGroupBy>('none');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [showSavedViews, setShowSavedViews] = useState(false);
  const [showEpicManager, setShowEpicManager] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showPhaseManager, setShowPhaseManager] = useState(false);
  const [showCustomFieldManager, setShowCustomFieldManager] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('json');
  const [exportSprintId, setExportSprintId] = useState<string>('');
  const [exporting, setExporting] = useState(false);

  const { data: projectRes } = useProject(projectId);
  const { data: boardData, isLoading: boardLoading } = useBoard(projectId, selectedSprintId);
  const { data: sprintsRes } = useSprints(projectId);
  const { data: projectsRes } = useProjects();
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const deleteProject = useDeleteProject();

  // Subscribe to realtime events for this project
  useRealtime(projectId);

  // Fetch project members
  const { data: membersRes } = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get<PaginatedResponse<Member>>(`/projects/${projectId}/members`),
    enabled: !!projectId,
  });
  const members = membersRes?.data ?? [];

  // Fetch project labels
  const { data: labelsRes } = useQuery({
    queryKey: ['project-labels', projectId],
    queryFn: () => api.get<PaginatedResponse<{ id: string; name: string; color: string }>>(`/projects/${projectId}/labels`),
    enabled: !!projectId,
  });
  const labels = labelsRes?.data ?? [];

  // Fetch project states
  const { data: statesRes } = useQuery({
    queryKey: ['project-states', projectId],
    queryFn: () => api.get<PaginatedResponse<{ id: string; name: string; category: string }>>(`/projects/${projectId}/states`),
    enabled: !!projectId,
  });
  const projectStates = statesRes?.data ?? [];

  const boardPhases = useBoardStore((s) => s.phases);
  const setBoardState = useBoardStore.setState;

  // When the user navigates between projects via the sidebar, React keeps
  // this component mounted and only swaps the `projectId` prop. Any local
  // state tied to the previous project (selected sprint, filters, the
  // active task drawer) would otherwise persist and point at rows that
  // do not belong to the new project. Reset the project-scoped bits
  // whenever projectId changes so the active sprint resolves freshly.
  useEffect(() => {
    setSelectedSprintId(undefined);
    setSelectedTaskId(null);
    setFilters({});
  }, [projectId]);

  useEffect(() => {
    if (boardData) {
      setBoardState({
        phases: boardData.phases,
        activeSprint: boardData.sprint,
      });
      if (!selectedSprintId && boardData.sprint) {
        setSelectedSprintId(boardData.sprint.id);
      }
    }
  }, [boardData, setBoardState, selectedSprintId]);

  const project = projectRes?.data;
  const sprints = sprintsRes?.data ?? [];
  const projects = projectsRes?.data ?? [];

  // Build member ID -> display name map for swimlane grouping
  const membersMap = useMemo(
    () => new Map(members.map((m) => [m.id, m.display_name])),
    [members],
  );

  const filteredPhases = boardPhases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.filter((task) => {
      if (filters.priority) {
        const priorities = filters.priority.split(',');
        if (!priorities.includes(task.priority)) return false;
      }
      if (filters.assignee_id) {
        const assignees = filters.assignee_id.split(',');
        if (!task.assignee_id || !assignees.includes(task.assignee_id)) return false;
      }
      if (filters.state_id) {
        const stateIds = filters.state_id.split(',');
        if (!task.state_id || !stateIds.includes(task.state_id)) return false;
      }
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!task.title.toLowerCase().includes(q) && !(task.human_id ?? '').toLowerCase().includes(q)) return false;
      }
      return true;
    }),
  }));

  const selectedTask = selectedTaskId
    ? boardPhases.flatMap((p) => p.tasks).find((t) => t.id === selectedTaskId) ?? null
    : null;

  const handleTaskClick = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
  }, []);

  const handleAddTask = useCallback((phaseId: string) => {
    setCreateDialogPhaseId(phaseId);
    setShowCreateDialog(true);
  }, []);

  const handleCreateTask = async (data: {
    title: string;
    phase_id: string;
    priority?: string;
    story_points?: number | null;
    description?: string;
    assignee_id?: string;
    due_date?: string;
    label_ids?: string[];
  }) => {
    await createTask.mutateAsync({
      projectId,
      data: {
        title: data.title,
        phase_id: data.phase_id,
        priority: (data.priority as Task['priority']) ?? 'medium',
        story_points: data.story_points ?? undefined,
        description: data.description,
        sprint_id: selectedSprintId,
        assignee_id: data.assignee_id === '__none__' ? undefined : data.assignee_id,
        due_date: data.due_date || undefined,
      },
    });
    setShowCreateDialog(false);
  };

  const handleInlineCreate = async (phaseId: string, title: string) => {
    await createTask.mutateAsync({
      projectId,
      data: {
        title,
        phase_id: phaseId,
        priority: 'medium',
        sprint_id: selectedSprintId,
      },
    });
  };

  const handleUpdateTask = (taskId: string, updates: Partial<Task>) => {
    // updateTask.mutate's data is the server's UpdateTaskInput shape, which
    // overlaps but is not identical to Partial<Task>. Cast through the
    // mutation's own parameter type so any drift stays scoped to this
    // call instead of widening the handler signature.
    updateTask.mutate(
      { taskId, data: updates as Parameters<typeof updateTask.mutate>[0]['data'] },
      {
        onError: (err: unknown) => {
          // B3 Frndo Launch: surface the done-gate rejection so the user
          // knows WHY their move was reverted. The optimistic update in
          // useUpdateTask still rolls back via the standard
          // queryClient.invalidateQueries path; we just add a heads-up.
          if (err instanceof ApiError && err.code === 'INCOMPLETE_SUBTASKS') {
            alert(err.message);
          }
        },
      },
    );
  };

  const handleDeleteTask = (taskId: string) => {
    deleteTask.mutate({ taskId }, {
      onSuccess: () => setSelectedTaskId(null),
    });
  };

  const handleDeleteProject = () => {
    if (!confirm('Are you sure you want to delete this project? This action cannot be undone.')) return;
    deleteProject.mutate(projectId, {
      onSuccess: () => onNavigate('/'),
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await api.post<Blob | Record<string, unknown>>(`/projects/${projectId}/export`, {
        format: exportFormat,
        sprint_id: exportSprintId || undefined,
      });
      const blob = res instanceof Blob
        ? res
        : new Blob([exportFormat === 'json' ? JSON.stringify(res, null, 2) : String(res)], {
            type: exportFormat === 'json' ? 'application/json' : 'text/csv',
          });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project?.name ?? 'export'}-${new Date().toISOString().split('T')[0]}.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setShowExportDialog(false);
    } catch {
      // error handling
    } finally {
      setExporting(false);
    }
  };

  // Keyboard shortcuts
  useKeyboardShortcuts(
    {
      n: () => setShowCreateDialog(true),
      s: () => {
        const el = document.getElementById('board-search-input');
        if (el) el.focus();
      },
      '/': () => {
        const el = document.getElementById('board-search-input');
        if (el) el.focus();
      },
      f: () => {
        const el = document.getElementById('board-search-input');
        if (el) el.focus();
      },
      Escape: () => {
        if (showCommandPalette) {
          setShowCommandPalette(false);
        } else if (showShortcuts) {
          setShowShortcuts(false);
        } else if (selectedTaskId) {
          setSelectedTaskId(null);
        } else if (showCreateDialog) {
          setShowCreateDialog(false);
        }
      },
      '?': () => setShowShortcuts((prev) => !prev),
      'Ctrl+k': () => setShowCommandPalette(true),
      'Cmd+k': () => setShowCommandPalette(true),
    },
    !showCreateDialog,
  );

  const renderView = () => {
    switch (viewMode) {
      case 'board':
        if (swimlaneGroupBy !== 'none') {
          return (
            <SwimlaneBoard
              phases={filteredPhases}
              groupBy={swimlaneGroupBy}
              onTaskClick={handleTaskClick}
              onAddTask={handleAddTask}
              members={membersMap}
            />
          );
        }
        return (
          <BoardView
            phases={filteredPhases}
            onTaskClick={handleTaskClick}
            onAddTask={handleAddTask}
            onInlineCreate={handleInlineCreate}
          />
        );

      case 'list':
        return (
          <ListView
            phases={filteredPhases}
            onTaskClick={handleTaskClick}
            onUpdateTask={handleUpdateTask}
          />
        );

      case 'timeline':
        return (
          <TimelineView
            phases={filteredPhases}
            onTaskClick={handleTaskClick}
          />
        );

      case 'calendar':
        return (
          <CalendarView
            phases={filteredPhases}
            onTaskClick={handleTaskClick}
          />
        );

      case 'workload':
        return (
          <WorkloadView
            projectId={projectId}
            onFilterByUser={(userId) => {
              if (userId === 'unassigned') return;
              setFilters((prev) => ({
                ...prev,
                assignee_id: prev.assignee_id === userId ? undefined : userId,
              }));
            }}
          />
        );

      default:
        return null;
    }
  };

  return (
    <AppLayout
      currentProjectId={projectId}
      breadcrumbs={[
        { label: 'Projects', href: '/' },
        { label: project?.name ?? 'Loading...' },
      ]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      {boardLoading ? (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      ) : (
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between gap-4 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0 flex-wrap">
            <div className="flex items-center gap-3">
              <SprintSelector
                sprints={sprints}
                activeSprint={boardData?.sprint}
                selectedSprintId={selectedSprintId}
                onSelectSprint={setSelectedSprintId}
                projectId={projectId}
                onNavigate={onNavigate}
              />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <FilterBar
                filters={filters}
                onFilterChange={setFilters}
                assignees={members.map((m) => ({ id: m.id, display_name: m.display_name }))}
                states={projectStates.map((s) => ({ id: s.id, name: s.name }))}
              />

              {viewMode === 'board' && (
                <Select
                  options={SWIMLANE_OPTIONS}
                  value={swimlaneGroupBy}
                  onValueChange={(val) => setSwimlaneGroupBy(val as SwimlanGroupBy)}
                  placeholder="Swimlanes"
                  className="w-40"
                />
              )}

              <ViewSwitcher activeView={viewMode} onViewChange={setViewMode} />

              <div className="flex items-center gap-1.5 border-l border-zinc-200 dark:border-zinc-700 pl-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate(`/projects/${projectId}/dashboard`)}
                  title="Dashboard"
                >
                  <BarChart3 className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowImportDialog(true)}
                  title="Import tasks"
                >
                  <Upload className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTemplateManager(true)}
                  title="Task templates"
                >
                  <FileText className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSavedViews((prev) => !prev)}
                  title="Saved views"
                >
                  <Bookmark className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowEpicManager(true)}
                  title="Manage epics"
                >
                  <Layers className="h-4 w-4" />
                </Button>
                <div className="relative">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowProjectMenu((prev) => !prev)}
                    title="Project options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                  {showProjectMenu && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setShowProjectMenu(false)} />
                      <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-lg border border-zinc-200 bg-white shadow-lg dark:bg-zinc-800 dark:border-zinc-700 py-1">
                        <button
                          onClick={() => {
                            setShowProjectMenu(false);
                            setShowPhaseManager(true);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                        >
                          <Layers className="h-4 w-4" />
                          Manage Phases
                        </button>
                        <button
                          onClick={() => {
                            setShowProjectMenu(false);
                            setShowCustomFieldManager(true);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                        >
                          <Layers className="h-4 w-4" />
                          Custom Fields
                        </button>
                        <button
                          onClick={() => {
                            setShowProjectMenu(false);
                            setShowExportDialog(true);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                        >
                          <Download className="h-4 w-4" />
                          Export
                        </button>
                        <button
                          onClick={() => {
                            setShowProjectMenu(false);
                            handleDeleteProject();
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete Project
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-hidden flex">
            <div className="flex-1 overflow-hidden">
              {renderView()}
            </div>
            {showSavedViews && (
              <SavedViewsPanel
                projectId={projectId}
                currentFilters={filters}
                currentViewType={viewMode}
                onApplyView={(view) => {
                  setFilters(view.filters as typeof filters);
                  setViewMode(view.view_type as ViewMode);
                  setShowSavedViews(false);
                }}
              />
            )}
          </div>
        </div>
      )}

      <TaskDetailDrawer
        open={!!selectedTaskId}
        onOpenChange={(open) => { if (!open) setSelectedTaskId(null); }}
        // TaskDetailDrawer expects the extended Task shape (human_id,
        // labels, assignee, etc.) that the board query returns; the
        // flatMap-lookup narrows to the base Task, so widen here.
        task={selectedTask as Parameters<typeof TaskDetailDrawer>[0]['task']}
        onUpdate={handleUpdateTask}
        onDelete={handleDeleteTask}
        phases={boardPhases.map((p) => ({ id: p.id, name: p.name }))}
        projectId={projectId}
        states={projectStates}
        sprints={sprints.map((s) => ({ id: s.id, name: s.name }))}
      />

      <CreateTaskDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        phases={boardPhases}
        defaultPhaseId={createDialogPhaseId}
        onSubmit={handleCreateTask}
        isLoading={createTask.isPending}
        members={members}
        labels={labels}
      />

      <KeyboardShortcutsOverlay
        open={showShortcuts}
        onOpenChange={setShowShortcuts}
      />

      <CommandPalette
        open={showCommandPalette}
        onOpenChange={setShowCommandPalette}
        onNavigate={onNavigate}
        onCreateTask={() => setShowCreateDialog(true)}
        projects={projects}
      />

      <ImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        projectId={projectId}
      />

      <TemplateManager
        open={showTemplateManager}
        onOpenChange={setShowTemplateManager}
        projectId={projectId}
      />

      <EpicManager
        open={showEpicManager}
        onOpenChange={setShowEpicManager}
        projectId={projectId}
      />

      <PhaseManager
        open={showPhaseManager}
        onOpenChange={setShowPhaseManager}
        projectId={projectId}
      />

      <CustomFieldManager
        open={showCustomFieldManager}
        onOpenChange={setShowCustomFieldManager}
        projectId={projectId}
      />

      {/* Export Dialog */}
      {showExportDialog && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowExportDialog(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-96 rounded-xl border border-zinc-200 bg-white shadow-xl dark:bg-zinc-800 dark:border-zinc-700 p-6 space-y-4">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Export Tasks</h2>
            <div>
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">Format</label>
              <div className="flex gap-2">
                {(['json', 'csv'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setExportFormat(fmt)}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      exportFormat === fmt
                        ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-zinc-800 dark:text-primary-400'
                        : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400'
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block">Sprint (optional)</label>
              <Select
                options={[
                  { value: '__all__', label: 'All sprints' },
                  ...sprints.map((s) => ({ value: s.id, label: s.name })),
                ]}
                value={exportSprintId || '__all__'}
                onValueChange={(v) => setExportSprintId(v === '__all__' ? '' : v)}
                className="w-full"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setShowExportDialog(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleExport} loading={exporting}>
                <Download className="h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </>
      )}
    </AppLayout>
  );
}
