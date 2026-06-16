import { useState, useMemo, useRef } from 'react';
import {
  addDays,
  addMonths,
  differenceInDays,
  startOfDay,
  format,
  isToday,
  parseISO,
  eachDayOfInterval,
  eachWeekOfInterval,
  eachMonthOfInterval,
} from 'date-fns';
import { ChevronRight, ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import type { Phase, Task } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';
import { usePriorityMap, type Priority } from '@/hooks/use-priorities';
import {
  type LaneSort,
  TIMELINE_SORT_OPTIONS,
  sortGroups,
  topPriority,
  topPriorityPosition,
  taskEpicRef,
  groupDateBounds,
} from '@/lib/epic-grouping';
import { EpicPriorityBadge } from '@/components/board/epic-group-ui';
import { Select } from '@/components/common/select';
import { TimelineExportMenu } from './timeline-export-menu';

type ZoomLevel = 'day' | 'week' | 'month';
type GroupBy = 'assignee' | 'phase' | 'epic';

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
  topPriorityPos?: number;
  topPriorityRow?: Priority | null;
  startMs?: number | null;
  endMs?: number | null;
}

/** "Mar 3 – Apr 12" style range for the collapsed-epic timeframe label. */
function formatRange(startMs: number | null | undefined, endMs: number | null | undefined): string | null {
  const s = startMs ?? endMs ?? null;
  const e = endMs ?? startMs ?? null;
  if (s === null || e === null) return null;
  const start = new Date(s);
  const end = new Date(e);
  const sameYear = start.getFullYear() === end.getFullYear();
  if (s === e) return format(start, 'MMM d, yyyy');
  return `${format(start, sameYear ? 'MMM d' : 'MMM d, yyyy')} – ${format(end, 'MMM d, yyyy')}`;
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
  const [laneSort, setLaneSort] = useState<LaneSort>('priority-desc');
  // Keys of collapsed groups. Collapsed = show only the name + timeframe;
  // expanded = show every task bar. State is local to the view (not persisted).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const { ordered: priorityRows } = usePriorityMap();

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  // Cumulative left offset of each column, for the month-view column-aware
  // mapping below.
  const columnLefts = useMemo(() => {
    const lefts: number[] = [];
    let acc = 0;
    for (const c of columns) {
      lefts.push(acc);
      acc += c.width;
    }
    return lefts;
  }, [columns]);

  // Convert a date to a pixel X position.
  const dateToX = (date: Date): number => {
    // Month view: the column headers are laid out as equal-width (180px) month
    // cells, but months have unequal day counts and the first cell starts on
    // the 1st (before the padded timelineStart). A purely linear day-based
    // mapping (used below for day/week, where columns are uniform) therefore
    // skews badly here — bars drift up to a full month off. Instead, place the
    // date proportionally WITHIN its own month column so bars line up exactly
    // with the headers.
    if (zoom === 'month') {
      if (columns.length === 0) return 0;
      const t = date.getTime();
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (!col) continue;
        const next = columns[i + 1];
        const colStart = col.date.getTime();
        const colEnd = next ? next.date.getTime() : addMonths(col.date, 1).getTime();
        // First column whose end is past the date owns it. For a date before
        // the very first column start this hits i=0 with a negative fraction,
        // which correctly extrapolates a hair to the left.
        if (t < colEnd) {
          const frac = (t - colStart) / (colEnd - colStart);
          return (columnLefts[i] ?? 0) + frac * col.width;
        }
      }
      // Past the last column: extrapolate forward at the last month's rate.
      const last = columns.length - 1;
      const lastCol = columns[last];
      if (!lastCol) return 0;
      const colStart = lastCol.date.getTime();
      const colEnd = addMonths(lastCol.date, 1).getTime();
      const frac = (t - colStart) / (colEnd - colStart);
      return (columnLefts[last] ?? 0) + frac * lastCol.width;
    }
    const totalDays = differenceInDays(timelineEnd, timelineStart) || 1;
    const dayOffset = differenceInDays(date, timelineStart);
    return (dayOffset / totalDays) * totalWidth;
  };

  // Build groups
  const groups: TimelineGroup[] = useMemo(() => {
    if (groupBy === 'phase') {
      return phases.map((p) => ({
        key: p.id,
        label: p.name,
        tasks: p.tasks,
        ...groupDateBounds(p.tasks),
      }));
    }
    if (groupBy === 'epic') {
      const posByValue = new Map(priorityRows.map((p) => [p.value, p.position]));
      const byEpic = new Map<string, { label: string; tasks: Task[] }>();
      for (const task of allTasks) {
        const epic = taskEpicRef(task);
        const key = epic?.id ?? task.epic_id ?? '__no_epic__';
        const label = epic?.name ?? 'No Epic';
        if (!byEpic.has(key)) byEpic.set(key, { label, tasks: [] });
        byEpic.get(key)!.tasks.push(task);
      }
      const built = [...byEpic.entries()].map(([key, val]) => ({
        key,
        label: val.label,
        tasks: val.tasks,
        topPriorityPos: topPriorityPosition(val.tasks, posByValue),
        topPriorityRow: topPriority(val.tasks, priorityRows),
        ...groupDateBounds(val.tasks),
      }));
      return sortGroups(built, laneSort);
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
      .map(([key, val]) => ({ key, label: val.label, tasks: val.tasks, ...groupDateBounds(val.tasks) }));
  }, [groupBy, phases, allTasks, laneSort, priorityRows]);

  // Collapse-all / expand-all toggle state, derived from the current groups.
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)));

  // Today marker position
  const todayX = dateToX(startOfDay(new Date()));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        {/* Group by tabs */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-0.5">
          {(['phase', 'assignee', 'epic'] as const).map((g) => (
            <button
              type="button"
              key={g}
              onClick={() => setGroupBy(g)}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                groupBy === g
                  ? 'bg-white dark:bg-zinc-900 text-primary-600 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              {g === 'phase' ? 'By Phase' : g === 'assignee' ? 'By Assignee' : 'By Epic'}
            </button>
          ))}
        </div>

        {groupBy === 'epic' && (
          <Select
            options={TIMELINE_SORT_OPTIONS}
            value={laneSort}
            onValueChange={(val) => setLaneSort(val as LaneSort)}
            placeholder="Sort epics"
            className="w-56"
          />
        )}

        {groups.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title={allCollapsed ? 'Expand all' : 'Collapse all'}
          >
            {allCollapsed ? (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            )}
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}

        {/* Zoom buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 p-0.5">
          {(['day', 'week', 'month'] as const).map((z) => (
            <button
              type="button"
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
            // The PNG export groups by phase/assignee only; fall back to
            // phase when the on-screen view is grouped by epic.
            groupBy={groupBy === 'epic' ? 'phase' : groupBy}
          />
        </div>
      </div>

      {/* Timeline body */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ minWidth: totalWidth + 200 }}>
          {/* Column headers */}
          <div className="flex sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            <div className="w-48 shrink-0 px-3 py-2 text-xs font-medium text-zinc-500 border-r border-zinc-200 dark:border-zinc-800">
              {groupBy === 'phase' ? 'Phase' : groupBy === 'epic' ? 'Epic' : 'Assignee'}
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
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const rangeText = formatRange(group.startMs, group.endMs);
            return (
            <div key={group.key} className="border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex">
                {/* Group label — click to expand/collapse */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  className="w-48 shrink-0 px-3 py-3 text-left text-sm font-medium text-zinc-700 dark:text-zinc-300 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 sticky left-0 z-[5] cursor-pointer select-none hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <span className="flex items-center gap-1">
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                    )}
                    <span className="truncate" title={group.label}>{group.label}</span>
                    <span className="text-xs text-zinc-400 shrink-0">({group.tasks.length})</span>
                  </span>
                  {group.topPriorityRow && (
                    <span className="mt-1 pl-[18px] block">
                      <EpicPriorityBadge priority={group.topPriorityRow} />
                    </span>
                  )}
                  {isCollapsed && rangeText && (
                    <span className="mt-1 pl-[18px] block text-[11px] font-normal text-zinc-400">
                      {rangeText}
                    </span>
                  )}
                </button>

                {/* Task bars area */}
                <div
                  className="relative flex-1"
                  style={{ minHeight: isCollapsed ? 44 : Math.max(40, group.tasks.length * 32 + 8) }}
                >
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

                  {isCollapsed ? (
                    /* Collapsed: a single summary bar spanning the group's
                       overall timeframe; click anywhere on it to expand. */
                    (() => {
                      const s = group.startMs ?? group.endMs ?? null;
                      const e = group.endMs ?? group.startMs ?? null;
                      if (s === null || e === null) {
                        return (
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.key)}
                            className="absolute left-2 top-3 text-[11px] italic text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                            title="No scheduled dates — click to expand"
                          >
                            No scheduled dates
                          </button>
                        );
                      }
                      const left = dateToX(new Date(s));
                      const right = dateToX(new Date(e));
                      const width = Math.max(right - left, 8);
                      return (
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className="absolute flex h-7 items-center rounded-md border border-primary-600 bg-primary-500/90 px-2 text-[11px] font-medium text-white truncate cursor-pointer hover:brightness-110 transition-all shadow-sm"
                          style={{ left, top: 6, width }}
                          title={`${group.label}${rangeText ? ` — ${rangeText}` : ''} (click to expand)`}
                        >
                          {group.label}
                        </button>
                      );
                    })()
                  ) : (
                    /* Expanded: one bar (or dot) per task. */
                    group.tasks.map((task, taskIdx) => {
                      const range = getTaskDateRange(task);
                      const top = taskIdx * 32 + 4;

                      if (range) {
                        const left = dateToX(range.start);
                        const right = dateToX(range.end);
                        const width = Math.max(right - left, 4);

                        return (
                          <button
                            type="button"
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
                          type="button"
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
                    })
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
