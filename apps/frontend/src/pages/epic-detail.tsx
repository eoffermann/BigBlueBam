import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, CheckCircle2, Calendar, Layers, Target } from 'lucide-react';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Badge } from '@/components/common/badge';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { markdownToHtml, sanitizeHtml } from '@/lib/markdown';
import { useProject } from '@/hooks/use-projects';

/**
 * Epic detail + rollup as returned by `GET /epics/:id`. Defined locally
 * (mirrors the `Epic` shape in the epics build contract) rather than pulled
 * from `@bigbluebam/shared` so this page compiles independently of the
 * parallel shared-type work. RECONCILE: swap for the shared `Epic` export
 * once it lands.
 */
interface EpicDetail {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  color: string | null;
  start_date: string | null;
  target_date: string | null;
  status: 'open' | 'in_progress' | 'closed';
  created_at: string;
  updated_at: string;
  task_count?: number;
  done_count?: number;
  total_story_points?: number;
  done_story_points?: number;
}

interface EpicTaskRow {
  id: string;
  human_id: string | null;
  title: string;
  parent_task_id: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  phase_name: string | null;
  state_category: string | null;
  completed_at: string | null;
  story_points: number | null;
}

interface EpicDetailPageProps {
  projectId: string;
  epicId: string;
  onNavigate: (path: string) => void;
}

const STATUS_META: Record<EpicDetail['status'], { label: string; variant: 'default' | 'info' | 'success' }> = {
  open: { label: 'Open', variant: 'default' },
  in_progress: { label: 'In Progress', variant: 'info' },
  closed: { label: 'Closed', variant: 'success' },
};

const FALLBACK_COLOR = '#a1a1aa'; // zinc-400

/** ISO week key (YYYY-Www) for grouping completed tasks in the burnup. */
function isoWeekKey(dateStr: string): string {
  const d = new Date(dateStr);
  // Shift to the Thursday of the current week to compute the ISO week number.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function ProgressBar({ done, total, label, color }: { done: number; total: number; label: string; color?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="text-zinc-500">
          {done} / {total} ({pct}%)
        </span>
      </div>
      <div className="w-full h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, backgroundColor: color ?? '#6366f1' }}
        />
      </div>
    </div>
  );
}

/**
 * Lightweight burnup: cumulative tasks completed per ISO week vs the total
 * scope line. Plain SVG, no chart library. Bars are cumulative completed
 * count; the dashed line is the total task count (full scope).
 */
function Burnup({ tasks, totalScope }: { tasks: EpicTaskRow[]; totalScope: number }) {
  const series = useMemo(() => {
    const completed = tasks
      .filter((t) => t.completed_at)
      .map((t) => ({ week: isoWeekKey(t.completed_at!), ts: new Date(t.completed_at!).getTime() }))
      .sort((a, b) => a.ts - b.ts);
    if (completed.length === 0) return [] as { week: string; cumulative: number }[];
    const byWeek = new Map<string, number>();
    for (const c of completed) {
      byWeek.set(c.week, (byWeek.get(c.week) ?? 0) + 1);
    }
    // Preserve chronological week order.
    const orderedWeeks = [...new Set(completed.map((c) => c.week))];
    let running = 0;
    return orderedWeeks.map((week) => {
      running += byWeek.get(week) ?? 0;
      return { week, cumulative: running };
    });
  }, [tasks]);

  if (series.length === 0) {
    return (
      <p className="text-sm text-zinc-400 py-4">
        No completed tasks yet — the burnup will populate as tasks are finished.
      </p>
    );
  }

  const max = Math.max(totalScope, 1);
  const barAreaHeight = 120;

  return (
    <div>
      <div className="relative flex items-end gap-3 h-[140px] border-l border-b border-zinc-200 dark:border-zinc-700 pl-3 pb-0">
        {/* Total-scope reference line */}
        <div
          className="absolute left-3 right-0 border-t border-dashed border-zinc-400 dark:border-zinc-500"
          style={{ bottom: `${20 + (totalScope / max) * barAreaHeight}px` }}
          aria-hidden
        >
          <span className="absolute -top-4 right-0 text-[10px] text-zinc-400">
            scope: {totalScope}
          </span>
        </div>
        {series.map((pt) => {
          const h = Math.max(2, (pt.cumulative / max) * barAreaHeight);
          return (
            <div key={pt.week} className="flex flex-col items-center gap-1 min-w-[28px]">
              <span className="text-[10px] text-zinc-500">{pt.cumulative}</span>
              <div
                className="w-6 rounded-t bg-primary-500"
                style={{ height: `${h}px` }}
                title={`${pt.week}: ${pt.cumulative} done cumulatively`}
              />
              <span className="text-[9px] text-zinc-400 whitespace-nowrap">{pt.week.replace(/^\d{4}-/, '')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EpicDetailPage({ projectId, epicId, onNavigate }: EpicDetailPageProps) {
  const queryClient = useQueryClient();
  const { data: projectRes } = useProject(projectId);
  const project = projectRes?.data;

  const { data: epicRes, isLoading: epicLoading } = useQuery({
    queryKey: ['epic', epicId],
    queryFn: () => api.get<{ data: EpicDetail }>(`/epics/${epicId}`),
    enabled: !!epicId,
  });
  const epic = epicRes?.data;

  const { data: tasksRes, isLoading: tasksLoading } = useQuery({
    queryKey: ['epic-tasks', epicId],
    queryFn: () => api.get<{ data: EpicTaskRow[] }>(`/epics/${epicId}/tasks`),
    enabled: !!epicId,
  });
  const tasks = tasksRes?.data ?? [];

  // Group tasks by sprint, preserving the API's sprint-then-position order.
  const groupedBySprint = useMemo(() => {
    const groups: { key: string; name: string; tasks: EpicTaskRow[] }[] = [];
    const index = new Map<string, number>();
    for (const t of tasks) {
      const key = t.sprint_id ?? '__no_sprint__';
      const name = t.sprint_name ?? 'No Sprint';
      let i = index.get(key);
      if (i === undefined) {
        i = groups.length;
        index.set(key, i);
        groups.push({ key, name, tasks: [] });
      }
      groups[i]!.tasks.push(t);
    }
    return groups;
  }, [tasks]);

  const closeEpic = useMutation({
    mutationFn: () => api.patch(`/epics/${epicId}`, { status: 'closed' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic', epicId] });
      queryClient.invalidateQueries({ queryKey: ['epics', projectId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });

  const taskCount = epic?.task_count ?? tasks.length;
  const doneCount = epic?.done_count ?? tasks.filter((t) => t.completed_at).length;
  const totalPoints = epic?.total_story_points ?? 0;
  const donePoints = epic?.done_story_points ?? 0;
  const showCloseNudge =
    !!epic && doneCount === taskCount && taskCount > 0 && epic.status !== 'closed';

  return (
    <AppLayout
      currentProjectId={projectId}
      breadcrumbs={[
        { label: 'Projects', href: '/' },
        { label: project?.name ?? 'Loading...', href: `/projects/${projectId}/board` },
        { label: epic?.name ?? 'Epic' },
      ]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      {epicLoading ? (
        <div className="flex items-center justify-center h-full">
          <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
        </div>
      ) : !epic ? (
        <div className="max-w-3xl mx-auto p-6">
          <Button variant="ghost" size="sm" onClick={() => onNavigate(`/projects/${projectId}/board`)}>
            <ArrowLeft className="h-4 w-4" />
            Back to Board
          </Button>
          <p className="mt-6 text-sm text-zinc-500">Epic not found.</p>
        </div>
      ) : (
        <div className="max-w-4xl mx-auto p-6 space-y-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(`/projects/${projectId}/board`)}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Board
          </Button>

          {/* Header */}
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span
                className="h-5 w-5 rounded-full shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow"
                style={{ backgroundColor: epic.color ?? FALLBACK_COLOR }}
                aria-hidden
              />
              <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{epic.name}</h1>
              <Badge variant={STATUS_META[epic.status].variant}>{STATUS_META[epic.status].label}</Badge>
            </div>

            <div className="flex items-center gap-4 text-sm text-zinc-500 flex-wrap">
              {epic.start_date && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  Start {formatDate(epic.start_date)}
                </span>
              )}
              {epic.target_date && (
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  Target {formatDate(epic.target_date)}
                </span>
              )}
            </div>

            {epic.description?.trim() && (
              <div
                className="rich-text-content text-sm text-zinc-700 dark:text-zinc-300 pt-1"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdownToHtml(epic.description)) }}
              />
            )}
          </div>

          {/* Close nudge */}
          {showCloseNudge && (
            <div className="flex items-center justify-between gap-4 rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/40 px-4 py-3">
              <span className="text-sm font-medium text-green-800 dark:text-green-300 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                All {taskCount} task{taskCount !== 1 ? 's' : ''} done — close this epic?
              </span>
              <Button size="sm" onClick={() => closeEpic.mutate()} loading={closeEpic.isPending}>
                Close Epic
              </Button>
            </div>
          )}

          {/* Progress */}
          <div className="space-y-4 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
            <ProgressBar done={doneCount} total={taskCount} label="Tasks completed" color={epic.color ?? undefined} />
            <ProgressBar done={donePoints} total={totalPoints} label="Story points completed" color={epic.color ?? undefined} />
          </div>

          {/* Burnup */}
          <div className="space-y-3 rounded-xl border border-zinc-200 dark:border-zinc-800 p-5">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Burnup (tasks completed per week)</h2>
            <Burnup tasks={tasks} totalScope={taskCount} />
          </div>

          {/* Task list grouped by sprint */}
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Layers className="h-4 w-4" />
              Tasks ({tasks.length})
            </h2>
            {tasksLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-primary-500" />
              </div>
            ) : groupedBySprint.length === 0 ? (
              <p className="text-sm text-zinc-400 py-2">No tasks assigned to this epic yet.</p>
            ) : (
              groupedBySprint.map((group) => (
                <div key={group.key} className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900/80 border-b border-zinc-200 dark:border-zinc-800">
                    <Target className="h-3.5 w-3.5 text-zinc-400" />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{group.name}</span>
                    <span className="text-xs text-zinc-400">
                      {group.tasks.filter((t) => t.completed_at).length}/{group.tasks.length} done
                    </span>
                  </div>
                  <div>
                    {group.tasks.map((t) => {
                      const isDone = !!t.completed_at;
                      return (
                        <button
                          key={t.id}
                          onClick={() => onNavigate(`/projects/${projectId}/board?task=${t.id}`)}
                          className="flex items-center gap-3 w-full text-left px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors last:border-b-0"
                        >
                          {isDone ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                          ) : (
                            <span className="h-4 w-4 rounded-full border-2 border-zinc-300 dark:border-zinc-600 shrink-0" />
                          )}
                          <span className="font-mono text-xs text-zinc-400 w-20 truncate shrink-0">
                            {t.human_id ?? t.id.slice(0, 6)}
                          </span>
                          <span className={isDone ? 'flex-1 text-sm text-zinc-400 line-through truncate' : 'flex-1 text-sm text-zinc-800 dark:text-zinc-200 truncate'}>
                            {t.title}
                          </span>
                          {t.story_points != null && (
                            <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded bg-zinc-100 dark:bg-zinc-800 px-1 text-xs font-medium text-zinc-500 shrink-0">
                              {t.story_points}
                            </span>
                          )}
                          {t.phase_name && (
                            <span className="text-xs text-zinc-400 hidden sm:inline shrink-0">{t.phase_name}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
