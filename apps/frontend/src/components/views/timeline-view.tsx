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
  /**
   * Commit a drag-edit of a task's dates. Sends ONLY the changed field(s):
   * a left-resize sends `{ start_date }`, a right-resize `{ due_date }`, a
   * move both. When omitted, range bars fall back to click-only behavior.
   */
  onUpdateTask?: (taskId: string, data: { start_date?: string; due_date?: string }) => void;
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

// Pixel travel below which a pointer gesture is treated as a click (open the
// inspector) rather than a drag (edit dates).
const DRAG_THRESHOLD_PX = 5;
// Width of each resize hit-zone at the bar's leading/trailing edge.
const EDGE_PX = 8;

type DragMode = 'move' | 'start' | 'end';

interface DragSession {
  mode: DragMode;
  startClientX: number;
  origLeft: number;
  origWidth: number;
  pointerId: number;
  moved: boolean;
  newStart?: Date;
  newEnd?: Date;
}

interface TimelineTaskBarProps {
  task: Task;
  range: { start: Date; end: Date };
  left: number;
  width: number;
  top: number;
  colorClass: string;
  borderClass: string;
  dateToX: (date: Date) => number;
  xToDate: (px: number) => Date;
  onTaskClick: (taskId: string) => void;
  onUpdateTask: (taskId: string, data: { start_date?: string; due_date?: string }) => void;
}

/**
 * A directly-manipulable timeline bar. Three hit zones by pointer x: the left
 * ~8px edge resizes start_date, the right ~8px edge resizes due_date, the
 * middle moves both (preserving span). A local draft drives the live preview
 * during the gesture; the change is committed to the server on pointer-up.
 *
 * Click vs drag: total pointer travel < 5px is a click (native onClick opens
 * the inspector, which also keeps keyboard Enter working); a real drag sets a
 * suppression flag so the trailing synthetic click does not re-open it.
 */
function TimelineTaskBar({
  task,
  range,
  left,
  width,
  top,
  colorClass,
  borderClass,
  dateToX,
  xToDate,
  onTaskClick,
  onUpdateTask,
}: TimelineTaskBarProps) {
  const [draft, setDraft] = useState<{ left: number; width: number } | null>(null);
  const session = useRef<DragSession | null>(null);
  // Set true when a gesture resolved as a drag, so the synthetic click that
  // follows pointer-up is swallowed instead of opening the inspector.
  const draggedRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Ignore secondary buttons; let the native context menu / etc. through.
    if (e.button !== 0) return;
    draggedRef.current = false;
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    let mode: DragMode = 'move';
    if (offsetX <= EDGE_PX) mode = 'start';
    else if (offsetX >= rect.width - EDGE_PX) mode = 'end';
    session.current = {
      mode,
      startClientX: e.clientX,
      origLeft: left,
      origWidth: width,
      pointerId: e.pointerId,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s) return;
    const delta = e.clientX - s.startClientX;
    if (Math.abs(delta) >= DRAG_THRESHOLD_PX) s.moved = true;

    if (s.mode === 'move') {
      const newStart = xToDate(s.origLeft + delta);
      const dayShift = differenceInDays(newStart, range.start);
      const newEnd = addDays(range.end, dayShift);
      s.newStart = newStart;
      s.newEnd = newEnd;
      const l = dateToX(newStart);
      setDraft({ left: l, width: Math.max(dateToX(newEnd) - l, 4) });
    } else if (s.mode === 'start') {
      let newStart = xToDate(s.origLeft + delta);
      // Can't push the start onto or past the end: keep at least a 1-day span.
      const maxStart = addDays(range.end, -1);
      if (newStart > maxStart) newStart = maxStart;
      s.newStart = newStart;
      const l = dateToX(newStart);
      setDraft({ left: l, width: Math.max(dateToX(range.end) - l, 4) });
    } else {
      let newEnd = xToDate(s.origLeft + s.origWidth + delta);
      const minEnd = addDays(range.start, 1);
      if (newEnd < minEnd) newEnd = minEnd;
      s.newEnd = newEnd;
      const l = dateToX(range.start);
      setDraft({ left: l, width: Math.max(dateToX(newEnd) - l, 4) });
    }
  };

  const endGesture = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    session.current = null;
    setDraft(null);
    if (!s) return;
    try {
      e.currentTarget.releasePointerCapture(s.pointerId);
    } catch {
      /* capture may already be gone (e.g. pointercancel) */
    }
    if (!s.moved) {
      // A click: leave it to the native onClick handler below.
      return;
    }
    draggedRef.current = true;
    if (s.mode === 'move' && s.newStart && s.newEnd) {
      onUpdateTask(task.id, {
        start_date: format(s.newStart, 'yyyy-MM-dd'),
        due_date: format(s.newEnd, 'yyyy-MM-dd'),
      });
    } else if (s.mode === 'start' && s.newStart) {
      onUpdateTask(task.id, { start_date: format(s.newStart, 'yyyy-MM-dd') });
    } else if (s.mode === 'end' && s.newEnd) {
      onUpdateTask(task.id, { due_date: format(s.newEnd, 'yyyy-MM-dd') });
    }
  };

  const displayLeft = draft?.left ?? left;
  const displayWidth = draft?.width ?? width;
  const dragging = draft !== null;

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onClick={() => {
        // Swallow the synthetic click that trails a real drag; otherwise a
        // genuine single click (or keyboard Enter) opens the inspector.
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        onTaskClick(task.id);
      }}
      className={cn(
        'group absolute h-6 rounded-md border text-[10px] font-medium text-white px-1.5 truncate shadow-sm select-none touch-none transition-[filter]',
        dragging ? 'cursor-grabbing brightness-110' : 'cursor-grab hover:brightness-110',
        colorClass,
        borderClass,
      )}
      style={{ left: displayLeft, top, width: displayWidth }}
      title={`${task.human_id ?? ''} ${task.title}`}
    >
      {/* Left resize grip */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-2 cursor-col-resize rounded-l-md bg-white/50 opacity-0 transition-opacity group-hover:opacity-100"
      />
      {task.title}
      {/* Right resize grip */}
      <span
        aria-hidden
        className="absolute inset-y-0 right-0 w-2 cursor-col-resize rounded-r-md bg-white/50 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

export function TimelineView({ phases, onTaskClick, onUpdateTask, projectName }: TimelineViewProps) {
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

  // Inverse of dateToX: map a pixel X back to a whole-day Date. Used by the
  // drag surface to translate pointer positions into concrete task dates.
  const xToDate = (px: number): Date => {
    if (zoom === 'month') {
      if (columns.length === 0) return timelineStart;
      // Locate the column whose [left, left+width) window owns px; anything
      // past the last column resolves against the last column (extrapolates).
      let idx = columns.length - 1;
      for (let i = 0; i < columns.length; i++) {
        const w = columns[i]?.width ?? 0;
        if (px < (columnLefts[i] ?? 0) + w) {
          idx = i;
          break;
        }
      }
      if (idx < 0) idx = 0;
      const col = columns[idx];
      if (!col) return timelineStart;
      const left = columnLefts[idx] ?? 0;
      const frac = col.width > 0 ? (px - left) / col.width : 0;
      const colStart = col.date;
      const colEnd = columns[idx + 1] ? columns[idx + 1]!.date : addMonths(colStart, 1);
      const spanDays = (colEnd.getTime() - colStart.getTime()) / 86_400_000;
      return addDays(colStart, Math.round(frac * spanDays));
    }
    const totalDays = differenceInDays(timelineEnd, timelineStart) || 1;
    const pxPerDay = totalWidth / totalDays;
    return addDays(timelineStart, Math.round(pxPerDay > 0 ? px / pxPerDay : 0));
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

                        // Only bars backed by BOTH dates are directly editable:
                        // there are two real handles to drag. Start-only /
                        // due-only bars (a single date, synthesized into a
                        // short range) stay click-only, like dots.
                        const hasBothDates = Boolean(
                          (task as Task & { start_date?: string | null }).start_date && task.due_date,
                        );

                        if (hasBothDates && onUpdateTask) {
                          return (
                            <TimelineTaskBar
                              key={task.id}
                              task={task}
                              range={range}
                              left={left}
                              width={width}
                              top={top}
                              colorClass={PRIORITY_COLORS[task.priority] ?? 'bg-zinc-400'}
                              borderClass={PRIORITY_BORDER_COLORS[task.priority] ?? 'border-zinc-500'}
                              dateToX={dateToX}
                              xToDate={xToDate}
                              onTaskClick={onTaskClick}
                              onUpdateTask={onUpdateTask}
                            />
                          );
                        }

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
