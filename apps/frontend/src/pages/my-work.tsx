import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle, Clock, Play, ListTodo } from 'lucide-react';
import type { Task, PaginatedResponse } from '@bigbluebam/shared';
import { AppLayout } from '@/components/layout/app-layout';
import { Badge } from '@/components/common/badge';
import { useAuthStore } from '@/stores/auth.store';
import { useProjects } from '@/hooks/use-projects';
import { api } from '@/lib/api';
import { cn, formatDate, isOverdue } from '@/lib/utils';

interface MyWorkPageProps {
  onNavigate: (path: string) => void;
}

interface TaskWithProject extends Task {
  project_name?: string;
  project_id: string;
}

function PriorityDot({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    critical: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-yellow-500',
    low: 'bg-blue-400',
    none: 'bg-zinc-300',
  };
  return <span className={cn('h-2 w-2 rounded-full shrink-0', colors[priority] ?? 'bg-zinc-300')} />;
}

function TaskRow({
  task,
  onNavigate,
}: {
  task: TaskWithProject;
  onNavigate: (path: string) => void;
}) {
  const overdue = isOverdue(task.due_date);

  return (
    <button
      onClick={() => onNavigate(`/projects/${task.project_id}/board`)}
      className="flex items-center gap-3 w-full text-left px-4 py-3 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
    >
      <PriorityDot priority={task.priority} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-mono text-zinc-400">{task.human_id}</span>
          {task.project_name && (
            <Badge variant="default">{task.project_name}</Badge>
          )}
        </div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
          {task.title}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {task.due_date && (
          <span className={cn('text-xs', overdue ? 'text-red-600 font-medium' : 'text-zinc-500')}>
            {formatDate(task.due_date)}
          </span>
        )}
      </div>
    </button>
  );
}

function TaskSection({
  title,
  icon,
  tasks,
  onNavigate,
  variant = 'default',
}: {
  title: string;
  icon: React.ReactNode;
  tasks: TaskWithProject[];
  onNavigate: (path: string) => void;
  variant?: 'default' | 'danger';
}) {
  if (tasks.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2 px-4">
        <span className={cn('text-zinc-500', variant === 'danger' && 'text-red-500')}>
          {icon}
        </span>
        <h2 className={cn(
          'text-sm font-semibold uppercase tracking-wider',
          variant === 'danger' ? 'text-red-600' : 'text-zinc-500',
        )}>
          {title}
        </h2>
        <span className={cn(
          'text-xs rounded-full px-1.5 py-0.5',
          variant === 'danger'
            ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400'
            : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400',
        )}>
          {tasks.length}
        </span>
      </div>
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/50">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

export function MyWorkPage({ onNavigate }: MyWorkPageProps) {
  const { user } = useAuthStore();
  const { data: projectsRes } = useProjects();
  const projects = projectsRes?.data ?? [];

  // Fetch tasks for each project assigned to current user
  const { data: allTasksRes, isLoading } = useQuery({
    queryKey: ['my-tasks', user?.id],
    queryFn: async () => {
      if (!user || projects.length === 0) return [];

      const results = await Promise.all(
        projects.map(async (project) => {
          try {
            const res = await api.get<PaginatedResponse<Task>>(
              `/projects/${project.id}/tasks`,
              // The list endpoint filters via the `filter[<field>]` param shape;
              // a bare `assignee_id` is ignored, which made My Work show ALL
              // tasks regardless of assignee.
              { 'filter[assignee_id]': user.id },
            );
            return res.data.map((t) => ({
              ...t,
              project_name: project.name,
            }));
          } catch {
            return [];
          }
        }),
      );
      return results.flat() as TaskWithProject[];
    },
    enabled: !!user && projects.length > 0,
  });

  const allTasks = allTasksRes ?? [];

  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));

  const sections = useMemo(() => {
    const overdueTasks: TaskWithProject[] = [];
    const dueThisWeek: TaskWithProject[] = [];
    const inProgress: TaskWithProject[] = [];
    const rest: TaskWithProject[] = [];

    for (const task of allTasks) {
      // Skip completed tasks
      if (task.completed_at) continue;

      const taskOverdue = isOverdue(task.due_date);
      const dueDate = task.due_date ? new Date(task.due_date) : null;
      const isDueThisWeek = dueDate && !taskOverdue && dueDate <= weekEnd;

      if (taskOverdue) {
        overdueTasks.push(task);
      } else if (isDueThisWeek) {
        dueThisWeek.push(task);
      } else if (task.start_date) {
        inProgress.push(task);
      } else {
        rest.push(task);
      }
    }

    return { overdueTasks, dueThisWeek, inProgress, rest };
  }, [allTasks, weekEnd]);

  return (
    <AppLayout
      breadcrumbs={[{ label: 'My Work' }]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-3xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">My Work</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Tasks assigned to you across all projects
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
          </div>
        ) : allTasks.filter((t) => !t.completed_at).length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ListTodo className="h-12 w-12 text-zinc-300 mb-4" />
            <h2 className="text-lg font-medium text-zinc-700 dark:text-zinc-300">
              All caught up!
            </h2>
            <p className="text-sm text-zinc-500 mt-1">
              No tasks are currently assigned to you.
            </p>
          </div>
        ) : (
          <>
            <TaskSection
              title="Overdue"
              icon={<AlertCircle className="h-4 w-4" />}
              tasks={sections.overdueTasks}
              onNavigate={onNavigate}
              variant="danger"
            />
            <TaskSection
              title="Due This Week"
              icon={<Clock className="h-4 w-4" />}
              tasks={sections.dueThisWeek}
              onNavigate={onNavigate}
            />
            <TaskSection
              title="In Progress"
              icon={<Play className="h-4 w-4" />}
              tasks={sections.inProgress}
              onNavigate={onNavigate}
            />
            <TaskSection
              title="All My Tasks"
              icon={<ListTodo className="h-4 w-4" />}
              tasks={sections.rest}
              onNavigate={onNavigate}
            />
          </>
        )}
      </div>
    </AppLayout>
  );
}
