import { useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { Phase, Task } from '@bigbluebam/shared';
import { useBoardStore } from '@/stores/board.store';
import { useMoveTask } from '@/hooks/use-tasks';
import { ApiError } from '@/lib/api';
import { useReducedMotion } from '@/hooks/use-reduced-motion';
import { usePriorityMap, type Priority } from '@/hooks/use-priorities';
import {
  type LaneSort,
  sortGroups,
  topPriority,
  topPriorityPosition,
  taskEpicRef,
} from '@/lib/epic-grouping';
import { EpicPriorityBadge, CollapseAllMenu } from './epic-group-ui';
import { PhaseColumn } from './phase-column';
import { TaskCard } from './task-card';

export type SwimlanGroupBy = 'none' | 'assignee' | 'priority' | 'epic';

interface SwimlaneGroup {
  key: string;
  label: string;
  tasks: Task[];
  taskCount: number;
  totalPoints: number;
  topPriorityPos: number;
  topPriorityRow: Priority | null;
}

interface SwimlaneBoardProps {
  phases: (Phase & { tasks: Task[] })[];
  groupBy: SwimlanGroupBy;
  /** Lane ordering when grouped by epic (priority/name, either direction). */
  laneSort?: LaneSort;
  onTaskClick: (taskId: string) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onEpicClick?: (epicId: string) => void;
  onAddTask: (phaseId: string) => void;
  members?: Map<string, string>; // userId -> displayName
}

function buildGroups(
  phases: (Phase & { tasks: Task[] })[],
  groupBy: SwimlanGroupBy,
  members?: Map<string, string>,
  priorityCatalog?: Priority[],
): SwimlaneGroup[] {
  const allTasks = phases.flatMap((p) => p.tasks);
  const pcat = priorityCatalog ?? [];
  const posByValue = new Map(pcat.map((p) => [p.value, p.position]));
  const decorate = (
    g: { key: string; label: string; tasks: Task[] },
  ): SwimlaneGroup => ({
    ...g,
    taskCount: g.tasks.length,
    totalPoints: g.tasks.reduce((sum, t) => sum + (t.story_points ?? 0), 0),
    topPriorityPos: topPriorityPosition(g.tasks, posByValue),
    topPriorityRow: topPriority(g.tasks, pcat),
  });

  if (groupBy === 'assignee') {
    const byAssignee = new Map<string, Task[]>();
    const labels = new Map<string, string>();

    for (const task of allTasks) {
      const key = task.assignee_id ?? '__unassigned__';
      const label = task.assignee_id && members?.get(task.assignee_id)
        ? members.get(task.assignee_id)!
        : 'Unassigned';
      if (!byAssignee.has(key)) {
        byAssignee.set(key, []);
        labels.set(key, key === '__unassigned__' ? 'Unassigned' : label);
      }
      byAssignee.get(key)!.push(task);
    }

    // Sort: unassigned last
    const keys = [...byAssignee.keys()].sort((a, b) => {
      if (a === '__unassigned__') return 1;
      if (b === '__unassigned__') return -1;
      return (labels.get(a) ?? '').localeCompare(labels.get(b) ?? '');
    });

    return keys.map((key) =>
      decorate({ key, label: labels.get(key) ?? 'Unknown', tasks: byAssignee.get(key)! }),
    );
  }

  if (groupBy === 'priority') {
    // Priority rows are org-scoped (migration 0183); when the catalog
    // hasn't loaded yet we fall back to the legacy hard-coded order so
    // the swimlane doesn't disappear under a flash of empty groups.
    const catalog = priorityCatalog && priorityCatalog.length > 0
      ? priorityCatalog
      : [
          { value: 'critical', name: 'Critical', position: 0 },
          { value: 'high',     name: 'High',     position: 1 },
          { value: 'medium',   name: 'Medium',   position: 2 },
          { value: 'low',      name: 'Low',      position: 3 },
          { value: 'none',     name: 'None',     position: 4 },
        ];
    return catalog
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((p) => decorate({ key: p.value, label: p.name, tasks: allTasks.filter((t) => t.priority === p.value) }));
  }

  if (groupBy === 'epic') {
    const byEpic = new Map<string, Task[]>();
    const labels = new Map<string, string>();

    for (const task of allTasks) {
      // The board payload enriches each task with `epic: {id, name, color}`
      // (see getBoardState). The legacy flat `epic_name` field this used to
      // read never exists on that payload, so every lane fell back to
      // "No Epic"; read the nested object instead.
      const epic = taskEpicRef(task);
      const key = epic?.id ?? task.epic_id ?? '__no_epic__';
      const label = epic?.name ?? 'No Epic';
      if (!byEpic.has(key)) {
        byEpic.set(key, []);
        labels.set(key, key === '__no_epic__' ? 'No Epic' : label);
      }
      byEpic.get(key)!.push(task);
    }

    // Order is applied by the caller via sortGroups(laneSort); just emit them.
    return [...byEpic.keys()].map((key) =>
      decorate({ key, label: labels.get(key) ?? 'Unknown', tasks: byEpic.get(key)! }),
    );
  }

  // 'none' — single group with all tasks
  return [decorate({ key: '__all__', label: 'All Tasks', tasks: allTasks })];
}

function filterPhasesForGroup(
  phases: (Phase & { tasks: Task[] })[],
  groupTasks: Task[],
): (Phase & { tasks: Task[] })[] {
  const taskIds = new Set(groupTasks.map((t) => t.id));
  return phases.map((phase) => ({
    ...phase,
    tasks: phase.tasks.filter((t) => taskIds.has(t.id)),
  }));
}

export function SwimlaneBoard({ phases, groupBy, laneSort = 'priority-desc', onTaskClick, onTaskContextMenu, onEpicClick, onAddTask, members }: SwimlaneBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [laneMenu, setLaneMenu] = useState<{ x: number; y: number } | null>(null);
  const moveTaskInStore = useBoardStore((s) => s.moveTask);
  const moveTaskMutation = useMoveTask();
  const prefersReducedMotion = useReducedMotion();
  const { ordered: priorityRows } = usePriorityMap();

  const groups = useMemo(() => {
    const built = buildGroups(phases, groupBy, members, priorityRows);
    // The configurable lane sort applies when grouping by epic; assignee/
    // priority/none keep their domain-specific ordering.
    return groupBy === 'epic' ? sortGroups(built, laneSort) : built;
  }, [phases, groupBy, members, priorityRows, laneSort]);

  const collapseAll = useCallback(
    () => setCollapsedGroups(new Set(groups.map((g) => g.key))),
    [groups],
  );
  const expandAll = useCallback(() => setCollapsedGroups(new Set()), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements = {
    onDragStart: ({ active }: DragStartEvent) => `Picked up task ${active.id}`,
    onDragOver: ({ active, over }: DragOverEvent) =>
      over ? `Task ${active.id} is over ${over.id}` : '',
    onDragEnd: ({ active, over }: DragEndEvent) =>
      over ? `Dropped task ${active.id} on ${over.id}` : 'Cancelled drag',
    onDragCancel: () => 'Drag cancelled',
  };

  const findTaskById = useCallback(
    (taskId: string): Task | undefined => {
      for (const phase of phases) {
        const task = phase.tasks.find((t) => t.id === taskId);
        if (task) return task;
      }
      return undefined;
    },
    [phases],
  );

  const findPhaseByTaskId = useCallback(
    (taskId: string): string | undefined => {
      for (const phase of phases) {
        if (phase.tasks.some((t) => t.id === taskId)) {
          return phase.id;
        }
      }
      return undefined;
    },
    [phases],
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = findTaskById(event.active.id as string);
    if (task) setActiveTask(task);
  };

  const handleDragOver = (_event: DragOverEvent) => {};

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id as string;
    let targetPhaseId: string | undefined;
    let targetPosition = 0;

    const overData = over.data.current;
    if (overData?.type === 'phase') {
      targetPhaseId = overData.phaseId as string;
      const targetPhase = phases.find((p) => p.id === targetPhaseId);
      const lastTask = targetPhase?.tasks[targetPhase.tasks.length - 1];
      targetPosition = (lastTask?.position ?? 0) + 1024;
    } else if (overData?.type === 'task') {
      const overTask = overData.task as Task;
      targetPhaseId = findPhaseByTaskId(overTask.id);
      const targetPhase = phases.find((p) => p.id === targetPhaseId);
      if (targetPhase) {
        const idx = targetPhase.tasks.findIndex((t) => t.id === overTask.id);
        if (idx === -1) {
          targetPosition = (targetPhase.tasks[targetPhase.tasks.length - 1]?.position ?? 0) + 1024;
        } else if (idx === 0) {
          targetPosition = (targetPhase.tasks[0]?.position ?? 1024) / 2;
        } else {
          const prev = targetPhase.tasks[idx - 1]!.position;
          const curr = targetPhase.tasks[idx]!.position;
          targetPosition = (prev + curr) / 2;
        }
      }
    }

    if (!targetPhaseId) return;

    moveTaskInStore(taskId, targetPhaseId, targetPosition);
    moveTaskMutation.mutate(
      {
        taskId,
        data: { phase_id: targetPhaseId, position: targetPosition },
      },
      {
        onError: (err: unknown) => {
          if (err instanceof ApiError && err.code === 'INCOMPLETE_SUBTASKS') {
            alert(err.message);
          }
        },
      },
    );
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (groupBy === 'none') {
    // Render as a normal board (no swimlane rows)
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements }}
      >
        <div className="flex gap-4 p-6 overflow-x-auto h-full">
          {phases.map((phase) => (
            <PhaseColumn
              key={phase.id}
              phase={phase}
              onTaskClick={onTaskClick}
              onTaskContextMenu={onTaskContextMenu}
              onEpicClick={onEpicClick}
              onAddTask={onAddTask}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }}>
          {activeTask ? <TaskCard task={activeTask} isDragOverlay /> : null}
        </DragOverlay>
      </DndContext>
    );
  }

  const motionTransition = prefersReducedMotion ? { duration: 0 } : { type: 'spring' as const, damping: 20, stiffness: 250 };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      accessibility={{ announcements }}
    >
      <div className="overflow-y-auto h-full p-6 space-y-2">
        {groups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.key);
          const groupPhases = filterPhasesForGroup(phases, group.tasks);

          return (
            <div key={group.key} className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              {/* Swimlane header. Right-click anywhere on it for collapse
                  all / expand all. */}
              <button
                onClick={() => toggleGroup(group.key)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setLaneMenu({ x: e.clientX, y: e.clientY });
                }}
                className="flex items-center gap-3 w-full px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900/80 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition-colors text-left"
                aria-expanded={!isCollapsed}
                title="Right-click for collapse all / expand all"
              >
                {isCollapsed ? (
                  <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
                )}
                <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 truncate max-w-[40vw]">
                  {group.label}
                </span>
                {group.topPriorityRow && <EpicPriorityBadge priority={group.topPriorityRow} />}
                <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded-full bg-zinc-200 dark:bg-zinc-700 px-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  {group.taskCount}
                </span>
                {group.totalPoints > 0 && (
                  <span className="text-xs text-zinc-500">
                    {group.totalPoints} pts
                  </span>
                )}
              </button>

              {/* Swimlane content */}
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={motionTransition}
                    className="overflow-hidden"
                  >
                    <div className="flex gap-4 p-4 overflow-x-auto">
                      {groupPhases.map((phase) => (
                        <PhaseColumn
                          key={`${group.key}-${phase.id}`}
                          laneKey={group.key}
                          phase={phase}
                          onTaskClick={onTaskClick}
                          onTaskContextMenu={onTaskContextMenu}
                          onEpicClick={onEpicClick}
                          onAddTask={onAddTask}
                        />
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' }}>
        {activeTask ? <TaskCard task={activeTask} isDragOverlay /> : null}
      </DragOverlay>

      {laneMenu && (
        <CollapseAllMenu
          x={laneMenu.x}
          y={laneMenu.y}
          onCollapseAll={collapseAll}
          onExpandAll={expandAll}
          onClose={() => setLaneMenu(null)}
        />
      )}
    </DndContext>
  );
}
