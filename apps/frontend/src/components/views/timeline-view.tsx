import { useState, useMemo, useRef } from 'react';
import {
  addDays,
  differenceInDays,
  startOfDay,
  format,
  isToday,
  parseISO,
  eachDayOfInterval,
  eachWeekOfInterval,
  eachMonthOfInterval,
} from 'date-fns';
import type { Phase, Task } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';
import { TimelineExportMenu } from './timeline-export-menu';

type ZoomLevel = 'day' | 'week' | 'month';
type GroupBy = 'assignee' | 'phase';

interface TimelineViewProps {
  phases: (Phase & { tasks: Task[] })[];
  onTaskClick: (taskId: string) => void;
  projectName?: string;
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-400',
  medium: 'bg-yellow-400',
  low: 'bg-blue-400',
  none: 'bg-zinc-400',
};

const PRIORITY_BORDER_COLORS: Record<string, string> = {
  critical: 'border-red-600',
  high: 'border-orange-500',
  medium: 'border-yellow-500',
  low: 'border-blue-500',
  none: 'border-zinc-500',
};

interface TimelineGroup {
  key: string;
  label: string;
  tasks: Task[];
}

function getTaskDateRange(task: Task): { start: Date; end: Date } | null {
  const startStr = (task as Task & { start_date?: string | null }).start_date;
  const endStr = task.due_date;

  if (startStr && endStr) {
    return { start: parseISO(startStr), end: parseISO(endStr) };
  }
  if (startStr) {
    return { start: parseISO(startStr), end: addDays(parseISO(startStr), 1) };
  }
  if (endStr) {
    return { start: parseISO(endStr), end: parseISO(endStr) };
  }
  return null;
}

function getTaskDot(task: Task): Date {
  return parseISO(task.created_at);
}

export function TimelineView({ phases, onTaskClick, projectName }: TimelineViewProps) {
  const [zoom, setZoom] = useState<ZoomLevel>('week');
  const [groupBy, setGroupBy] = useState<GroupBy>('phase');
  const scrollRef = useRef<HTMLDivElement>(null);

  const allTasks = useMemo(() => phases.flatMap((p) => p.tasks), [phases]);

  // Determine timeline bounds
  const { timelineStart, timelineEnd } = useMemo(() => {
    const now = new Date();
    let earliest = now;
    let latest = now;

    for (const task of allTasks) {
      const range = getTaskDateRange(task);
      if (range) {
        if (range.start < earliest) earliest = range.start;
        if (range.end > latest) latest = range.end;
      } else {
        const dot = getTaskDot(task);
        if (dot < earliest) earliest = dot;
        if (dot > latest) latest = dot;
      }
    }

    // Add padding
    const start = addDays(startOfDay(earliest), -7);
    const end = addDays(startOfDay(latest), 14);
    return { timelineStart: start, timelineEnd: end };
  }, [allTasks]);

  // Compute columns
  const columns = useMemo(() => {
    if (zoom === 'day') {
      return eachDayOfInterval({ start: timelineStart, end: timelineEnd }).map((d) => ({
        date: d,
        label: format(d, 'd'),
        headerLabel: format(d, 'MMM d'),
        width: 40,
      }));
    }
    if (zoom === 'week') {
      return eachWeekOfInterval({ start: timelineStart, end: timelineEnd }, { weekStartsOn: 1 }).map((d) => ({
        date: d,
        label: format(d, 'MMM d'),
        headerLabel: format(d, 'MMM d'),
        width: 120,
      }));
    }
    // month
    return eachMonthOfInterval({ start: timelineStart, end: timelineEnd }).map((d) => ({
      date: d,
      label: format(d, 'MMM yyyy'),
      headerLabel: format(d, 'MMM yyyy'),
      width: 180,
    }));
  }, [zoom, timelineStart, timelineEnd]);

  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);

  // Convert a date to pixel X position
  const dateToX = (date: Date): number => {
    const totalDays = differenceInDays(timelineEnd, timelineStart) || 1;
    const dayOffset = differenceInDays(date, timelineStart);
    return (dayOffset / totalDays) * totalWidth;
  };

  // Build groups
  const groups: TimelineGroup[] = useMemo(() => {
    if (groupBy === 'phase') {
      return phases.map((p) => ({ key: p.id, label: p.name, tasks: p.tasks }));
    }
    // assignee
    const byAssignee = new Map<string, { label: string; tasks: Task[] }>();
    for (const task of allTasks) {
      const key = task.assignee_id ?? '__unassigned__';
      const assignee = (task as Task & { assignee?: { display_name: string } | null }).assignee;
      const label = key === '__unassigned__' ? 'Unassigned' : (assignee?.display_name ?? 'Unknown');
      if (!byAssignee.has(key)) {
        byAssignee.set(key, { label, tasks: [] });
      }
      byAssignee.get(key)!.tasks.push(task);
    }
    return [...byAssignee.entries()]
      .sort(([a], [b]) => {
        if (a === '__unassigned__') return 1;
        if (b === '__unassigned__') return -1;
        return 0;
      })
      .map(([key, val]) => ({ key, label: val.label, tasks: val.tasks }));
  }, [groupBy, phases, allTasks]);

  // Today marker position
  const todayX = dateToX(startOfDay(new Date()));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        {/* Group by tabs */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-0.5">
          {(['phase', 'assignee'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                groupBy === g
                  ? 'bg-white dark:bg-zinc-900 text-primary-600 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              {g === 'phase' ? 'By Phase' : 'By Assignee'}
            </button>
          ))}
        </div>

        {/* Zoom buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-0.5">
          {(['day', 'week', 'month'] as const).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize',
                zoom === z
                  ? 'bg-white dark:bg-zinc-900 text-primary-600 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              {z}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <TimelineExportMenu
            phases={phases}
            projectName={projectName ?? 'Project'}
            groupBy={groupBy}
          />
        </div>
      </div>

      {/* Timeline body */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ minWidth: totalWidth + 200 }}>
          {/* Column headers */}
          <div className="flex sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            <div className="w-48 shrink-0 px-3 py-2 text-xs font-medium text-zinc-500 border-r border-zinc-200 dark:border-zinc-800">
              {groupBy === 'phase' ? 'Phase' : 'Assignee'}
            </div>
            <div className="relative flex-1">
              <div className="flex">
                {columns.map((col, idx) => (
                  <div
                    key={idx}
                    style={{ width: col.width }}
                    className={cn(
                      'shrink-0 px-2 py-2 text-xs text-zinc-500 text-center border-r border-zinc-100 dark:border-zinc-800',
                      isToday(col.date) && 'bg-red-50 dark:bg-red-950/20 font-medium text-red-600',
                    )}
                  >
                    {col.headerLabel}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Groups + rows */}
          {groups.map((group) => (
            <div key={group.key} className="border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex">
                {/* Group label */}
                <div className="w-48 shrink-0 px-3 py-3 text-sm font-medium text-zinc-700 dark:text-zinc-300 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 sticky left-0 z-[5]">
                  {group.label}
                  <span className="text-xs text-zinc-400 ml-1">({group.tasks.length})</span>
                </div>

                {/* Task bars area */}
                <div className="relative flex-1" style={{ minHeight: Math.max(40, group.tasks.length * 32 + 8) }}>
                  {/* Grid lines */}
                  {columns.map((col, idx) => (
                    <div
                      key={idx}
                      className="absolute top-0 bottom-0 border-r border-zinc-100 dark:border-zinc-800/50"
                      style={{ left: dateToX(col.date), width: 1 }}
                    />
                  ))}

                  {/* Today marker */}
                  {todayX > 0 && todayX < totalWidth && (
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-[3]"
                      style={{ left: todayX }}
                      title="Today"
                    />
                  )}

                  {/* Task bars */}
                  {group.tasks.map((task, taskIdx) => {
                    const range = getTaskDateRange(task);
                    const top = taskIdx * 32 + 4;

                    if (range) {
                      const left = dateToX(range.start);
                      const right = dateToX(range.end);
                      const width = Math.max(right - left, 4);

                      return (
                        <button
                          key={task.id}
                          onClick={() => onTaskClick(task.id)}
                          className={cn(
                            'absolute h-6 rounded-md border text-[10px] font-medium text-white px-1.5 truncate cursor-pointer hover:brightness-110 transition-all shadow-sm',
                            PRIORITY_COLORS[task.priority] ?? 'bg-zinc-400',
                            PRIORITY_BORDER_COLORS[task.priority] ?? 'border-zinc-500',
                          )}
                          style={{ left, top, width }}
                          title={`${task.human_id ?? ''} ${task.title}`}
                        >
                          {task.title}
                        </button>
                      );
                    }

                    // No dates: render as a dot at creation date
                    const dotDate = getTaskDot(task);
                    const dotX = dateToX(dotDate);

                    return (
                      <button
                        key={task.id}
                        onClick={() => onTaskClick(task.id)}
                        className={cn(
                          'absolute h-4 w-4 rounded-full border-2 cursor-pointer hover:scale-125 transition-transform',
                          PRIORITY_COLORS[task.priority] ?? 'bg-zinc-400',
                          PRIORITY_BORDER_COLORS[task.priority] ?? 'border-zinc-500',
                        )}
                        style={{ left: dotX - 8, top: top + 4 }}
                        title={`${task.human_id ?? ''} ${task.title} (no dates set)`}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
