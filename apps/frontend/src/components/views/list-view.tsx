import { useState, useMemo, useCallback } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, CornerDownRight, ChevronDown, ChevronRight } from 'lucide-react';
import type { Task, Phase, Priority } from '@bigbluebam/shared';
import { PRIORITIES } from '@bigbluebam/shared';
import { cn, formatDate, isOverdue } from '@/lib/utils';
import { Badge } from '@/components/common/badge';
import { Select } from '@/components/common/select';
import { EpicChip, taskEpic } from '@/components/board/epic-chip';
import { EpicPriorityBadge, CollapseAllMenu } from '@/components/board/epic-group-ui';
import { usePriorityMap } from '@/hooks/use-priorities';
import {
  type LaneSort,
  LANE_SORT_OPTIONS,
  sortGroups,
  topPriority,
  topPriorityPosition,
  taskEpicRef,
} from '@/lib/epic-grouping';

type SortField = 'human_id' | 'title' | 'state_name' | 'phase_name' | 'assignee' | 'priority' | 'story_points' | 'due_date' | 'created_at';
type SortDirection = 'asc' | 'desc';

interface ListViewProps {
  phases: (Phase & { tasks: Task[] })[];
  onTaskClick: (taskId: string) => void;
  onUpdateTask?: (taskId: string, data: Partial<Task>) => void;
  /** Navigate to the epic detail route when a row's epic chip is clicked. */
  onEpicClick?: (epicId: string) => void;
}

const priorityOrder: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

// PriorityIcon removed — not currently rendered by this view. Reintroduce
// from git history if columns start showing priority badges again.

export function ListView({ phases, onTaskClick, onUpdateTask, onEpicClick }: ListViewProps) {
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [groupByEpic, setGroupByEpic] = useState(false);
  const [laneSort, setLaneSort] = useState<LaneSort>('priority-desc');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [laneMenu, setLaneMenu] = useState<{ x: number; y: number } | null>(null);
  const { ordered: priorityRows } = usePriorityMap();

  const allTasks = useMemo(() => {
    const tasks: (Task & { phase_name?: string; state_name?: string })[] = [];
    for (const phase of phases) {
      for (const task of phase.tasks) {
        tasks.push({ ...task, phase_name: phase.name });
      }
    }
    return tasks;
  }, [phases]);

  const compareTasks = useMemo(() => {
    return (a: Task, b: Task): number => {
      let cmp = 0;
      switch (sortField) {
        case 'human_id':
          cmp = (a.human_id ?? '').localeCompare(b.human_id ?? '');
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'state_name':
          cmp = ((a as { state_name?: string }).state_name ?? '').localeCompare((b as { state_name?: string }).state_name ?? '');
          break;
        case 'phase_name':
          cmp = ((a as { phase_name?: string }).phase_name ?? '').localeCompare((b as { phase_name?: string }).phase_name ?? '');
          break;
        case 'priority':
          cmp = (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
          break;
        case 'story_points':
          cmp = (a.story_points ?? 0) - (b.story_points ?? 0);
          break;
        case 'due_date':
          cmp = (a.due_date ?? '').localeCompare(b.due_date ?? '');
          break;
        case 'created_at':
          cmp = a.created_at.localeCompare(b.created_at);
          break;
        default:
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    };
  }, [sortField, sortDir]);

  // Hierarchical rows: top-level tasks (no parent IN THIS DATASET) first,
  // children indented beneath each of their parents, recursively. A task
  // with several parents appears under every one of them — same task,
  // several rows — so the unique render key is the full path, not the id.
  // The chosen column sort applies within each sibling group. Cycle
  // defense: a task already on the current ancestor path is skipped (the
  // server guards against creating cycles, but the view must never
  // infinite-loop on bad data), plus a hard depth cap.
  const treeRows = useMemo(() => {
    type Row = { task: (typeof allTasks)[number]; depth: number; pathKey: string };
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const childrenByParent = new Map<string, typeof allTasks>();
    const roots: typeof allTasks = [];
    for (const t of allTasks) {
      const parentRefs =
        t.parents ?? (t.parent_task_id ? [{ id: t.parent_task_id, human_id: null }] : []);
      const presentParents = parentRefs.filter((p) => byId.has(p.id));
      if (presentParents.length === 0) {
        // No parents, or parents outside the current board/sprint — show
        // at top level rather than hiding the task.
        roots.push(t);
      }
      for (const p of presentParents) {
        const list = childrenByParent.get(p.id) ?? [];
        list.push(t);
        childrenByParent.set(p.id, list);
      }
    }
    const rows: Row[] = [];
    const visit = (t: (typeof allTasks)[number], depth: number, path: Set<string>, pathKey: string) => {
      rows.push({ task: t, depth, pathKey });
      if (depth >= 12) return;
      const kids = (childrenByParent.get(t.id) ?? []).slice().sort(compareTasks);
      for (const k of kids) {
        if (path.has(k.id)) continue;
        const nextPath = new Set(path);
        nextPath.add(k.id);
        visit(k, depth + 1, nextPath, `${pathKey}/${k.id}`);
      }
    };
    for (const r of roots.slice().sort(compareTasks)) {
      visit(r, 0, new Set([r.id]), r.id);
    }
    return rows;
  }, [allTasks, compareTasks]);

  // Epic-grouped rows: each epic a collapsible section (parent + subtasks
  // both carry the epic), tasks within sorted by the active column sort.
  const epicGroups = useMemo(() => {
    const posByValue = new Map(priorityRows.map((p) => [p.value, p.position]));
    const byEpic = new Map<string, { label: string; tasks: typeof allTasks }>();
    for (const t of allTasks) {
      const epic = taskEpicRef(t);
      const key = epic?.id ?? t.epic_id ?? '__no_epic__';
      const label = epic?.name ?? 'No Epic';
      if (!byEpic.has(key)) byEpic.set(key, { label, tasks: [] });
      byEpic.get(key)!.tasks.push(t);
    }
    const built = [...byEpic.entries()].map(([key, val]) => ({
      key,
      label: val.label,
      tasks: val.tasks.slice().sort(compareTasks),
      topPriorityPos: topPriorityPosition(val.tasks, posByValue),
      topPriorityRow: topPriority(val.tasks, priorityRows),
    }));
    return sortGroups(built, laneSort);
  }, [allTasks, compareTasks, laneSort, priorityRows]);

  const collapseAll = useCallback(
    () => setCollapsed(new Set(epicGroups.map((g) => g.key))),
    [epicGroups],
  );
  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-zinc-300" />;
    return sortDir === 'asc'
      ? <ArrowUp className="h-3 w-3 text-primary-500" />
      : <ArrowDown className="h-3 w-3 text-primary-500" />;
  };

  const priorityOptions = PRIORITIES.map((p) => ({
    value: p,
    label: p.charAt(0).toUpperCase() + p.slice(1),
  }));

  const columns: { field: SortField; label: string; className: string }[] = [
    { field: 'human_id', label: 'ID', className: 'w-24' },
    { field: 'title', label: 'Title', className: 'flex-1 min-w-[200px]' },
    { field: 'phase_name', label: 'Phase', className: 'w-28' },
    { field: 'priority', label: 'Priority', className: 'w-32' },
    { field: 'story_points', label: 'Points', className: 'w-20' },
    { field: 'due_date', label: 'Due Date', className: 'w-28' },
    { field: 'created_at', label: 'Created', className: 'w-28' },
  ];

  const renderRow = (task: (typeof allTasks)[number], depth: number, key: string) => {
    const overdue = isOverdue(task.due_date);
    const epic = taskEpic(task);
    return (
      <div
        key={key}
        className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 cursor-pointer transition-colors text-sm"
        onClick={() => onTaskClick(task.id)}
      >
        {depth > 0 && (
          <div
            className="shrink-0 flex items-center justify-end text-zinc-300 dark:text-zinc-600"
            style={{ width: depth * 18 }}
            aria-hidden
          >
            <CornerDownRight className="h-3.5 w-3.5" />
          </div>
        )}
        <div className="w-24 font-mono text-xs text-zinc-400 truncate shrink-0">
          {task.human_id}
        </div>
        <div className="flex-1 min-w-[200px] min-w-0">
          <div className="text-zinc-900 dark:text-zinc-100 font-medium truncate">
            {task.title}
          </div>
          {/* Hide the epic chip when already grouped by epic — redundant. */}
          {!groupByEpic && epic && (
            <div className="mt-0.5">
              <EpicChip epic={epic} onClick={onEpicClick ? () => onEpicClick(epic.id) : undefined} />
            </div>
          )}
        </div>
        <div className="w-28 truncate">
          <Badge variant="default">{(task as { phase_name?: string }).phase_name ?? '-'}</Badge>
        </div>
        <div className="w-32" onClick={(e) => e.stopPropagation()}>
          <Select
            options={priorityOptions}
            value={task.priority}
            onValueChange={(val) => onUpdateTask?.(task.id, { priority: val as Priority })}
            className="w-full"
          />
        </div>
        <div className="w-20" onClick={(e) => e.stopPropagation()}>
          <input
            type="number"
            min={0}
            value={task.story_points ?? ''}
            onChange={(e) => {
              const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
              onUpdateTask?.(task.id, { story_points: val } as Partial<Task>);
            }}
            className="w-full rounded border border-zinc-200 bg-transparent px-2 py-1 text-xs text-center focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-zinc-700 dark:text-zinc-100"
            placeholder="-"
          />
        </div>
        <div className={cn('w-28 text-xs', overdue ? 'text-red-600 font-medium' : 'text-zinc-500')}>
          {task.due_date ? formatDate(task.due_date) : '-'}
        </div>
        <div className="w-28 text-xs text-zinc-400">{formatDate(task.created_at)}</div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Controls: group-by-epic toggle + (when on) lane sort */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <button
          type="button"
          onClick={() => setGroupByEpic((v) => !v)}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-sm transition-colors',
            groupByEpic
              ? 'border-primary-300 bg-primary-50 text-primary-700 dark:border-primary-700 dark:bg-zinc-800 dark:text-primary-400'
              : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-400',
          )}
        >
          Group by Epic
        </button>
        {groupByEpic && (
          <Select
            options={LANE_SORT_OPTIONS}
            value={laneSort}
            onValueChange={(val) => setLaneSort(val as LaneSort)}
            placeholder="Sort epics"
            className="w-48"
          />
        )}
        {groupByEpic && (
          <span className="text-xs text-zinc-400">Right-click an epic header for collapse all / expand all</span>
        )}
      </div>

      {/* Column header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 text-xs font-medium text-zinc-500 uppercase tracking-wider shrink-0">
        {columns.map((col) => (
          <button
            key={col.field}
            onClick={() => handleSort(col.field)}
            className={cn(
              'flex items-center gap-1 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors',
              col.className,
            )}
          >
            {col.label}
            <SortIcon field={col.field} />
          </button>
        ))}
      </div>

      {/* Table body */}
      <div className="flex-1 overflow-y-auto">
        {allTasks.length === 0 ? (
          <div className="flex items-center justify-center h-40 text-sm text-zinc-400">
            No tasks found.
          </div>
        ) : groupByEpic ? (
          epicGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() => toggleSection(group.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setLaneMenu({ x: e.clientX, y: e.clientY });
                  }}
                  className="flex items-center gap-2 w-full px-4 py-2 bg-zinc-50 dark:bg-zinc-900/70 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 border-b border-zinc-200 dark:border-zinc-800 text-left sticky top-0 z-[5]"
                  title="Right-click for collapse all / expand all"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
                  )}
                  <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 truncate max-w-[50vw]">
                    {group.label}
                  </span>
                  {group.topPriorityRow && <EpicPriorityBadge priority={group.topPriorityRow} />}
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded-full bg-zinc-200 dark:bg-zinc-700 px-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {group.tasks.length}
                  </span>
                </button>
                {!isCollapsed && group.tasks.map((t) => renderRow(t, 0, `${group.key}/${t.id}`))}
              </div>
            );
          })
        ) : (
          treeRows.map(({ task, depth, pathKey }) => renderRow(task, depth, pathKey))
        )}
      </div>

      {laneMenu && (
        <CollapseAllMenu
          x={laneMenu.x}
          y={laneMenu.y}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
          onClose={() => setLaneMenu(null)}
        />
      )}
    </div>
  );
}
