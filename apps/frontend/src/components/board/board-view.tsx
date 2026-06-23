import { useState, useCallback } from 'react';
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
import type { Phase, Task } from '@bigbluebam/shared';
import { useBoardStore } from '@/stores/board.store';
import { useMoveTask, useAddTaskParent } from '@/hooks/use-tasks';
import { ApiError } from '@/lib/api';
import { PhaseColumn } from './phase-column';
import { TaskCard } from './task-card';
import { NestTargetContext } from './board-drag-context';

// Vertical-center "sweet spot" of a task card that means "nest" instead of
// "reorder": the middle 40% (0.30–0.70). Dragging across the top/bottom 30%
// reorders as before; releasing in the center adds the dragged task as a child
// of the hovered one. The band is deliberately away from the edges so ordinary
// reordering never nests by accident.
const NEST_ZONE_MIN = 0.3;
const NEST_ZONE_MAX = 0.7;

/**
 * Decide whether the drag is in the nest zone of the task it is over. Uses the
 * dragged card's translated center Y relative to the over card's rect (both
 * provided by dnd-kit), so it is independent of pointer jitter. Returns the
 * over-task id when nesting applies, else null.
 */
function nestTargetFromEvent(event: DragEndEvent | DragOverEvent): string | null {
  const { active, over } = event;
  if (!over) return null;
  const overData = over.data.current;
  if (overData?.type !== 'task') return null;
  if (over.id === active.id) return null; // can't nest into itself
  const overRect = over.rect;
  const activeRect = active.rect.current.translated;
  if (!overRect || !activeRect) return null;
  const activeCenterY = activeRect.top + activeRect.height / 2;
  const rel = (activeCenterY - overRect.top) / overRect.height;
  return rel >= NEST_ZONE_MIN && rel <= NEST_ZONE_MAX ? (over.id as string) : null;
}

interface BoardViewProps {
  phases: (Phase & { tasks: Task[] })[];
  onTaskClick: (taskId: string) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onEpicClick?: (epicId: string) => void;
  onAddTask: (phaseId: string) => void;
  onInlineCreate?: (phaseId: string, title: string) => Promise<void>;
}

export function BoardView({ phases, onTaskClick, onTaskContextMenu, onEpicClick, onAddTask, onInlineCreate }: BoardViewProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [nestTargetId, setNestTargetId] = useState<string | null>(null);
  const moveTaskInStore = useBoardStore((s) => s.moveTask);
  const moveTaskMutation = useMoveTask();
  const addTaskParent = useAddTaskParent();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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

  const handleDragOver = (event: DragOverEvent) => {
    // Track whether the drag is hovering a card's center sweet spot so that
    // card can show its "add as child" affordance. DragOverlay handles the
    // rest of the visual feedback.
    setNestTargetId(nestTargetFromEvent(event));
  };

  const handleDragCancel = () => {
    setActiveTask(null);
    setNestTargetId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null);

    const { active, over } = event;
    if (!over) {
      setNestTargetId(null);
      return;
    }

    const taskId = active.id as string;

    // Nesting takes precedence over reordering: a release in the center sweet
    // spot adds the dragged task as a child of the hovered one and does NOT
    // move it between phases/positions. The board refetches on success so the
    // child shows its parent badge and the parent's subtask progress updates.
    const nestParentId = nestTargetFromEvent(event);
    setNestTargetId(null);
    if (nestParentId && nestParentId !== taskId) {
      addTaskParent.mutate(
        { taskId, parentTaskId: nestParentId },
        {
          onError: (err: unknown) => {
            // Cycle guard / other rejections come back from the API; surface
            // the reason rather than silently doing nothing.
            if (err instanceof ApiError) alert(err.message);
          },
        },
      );
      return;
    }
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

    const currentPhaseId = findPhaseByTaskId(taskId);
    if (currentPhaseId === targetPhaseId) {
      const phase = phases.find((p) => p.id === targetPhaseId);
      if (phase) {
        const currentIndex = phase.tasks.findIndex((t) => t.id === taskId);
        if (currentIndex === targetPosition) return;
      }
    }

    moveTaskInStore(taskId, targetPhaseId, targetPosition);

    moveTaskMutation.mutate(
      {
        taskId,
        data: { phase_id: targetPhaseId, position: targetPosition },
      },
      {
        onError: (err: unknown) => {
          // B3 Frndo Launch: surface the done-gate rejection. The board
          // will refetch on settle, so the card snaps back to its original
          // phase; the alert tells the user why.
          if (err instanceof ApiError && err.code === 'INCOMPLETE_SUBTASKS') {
            alert(err.message);
          }
        },
      },
    );
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      accessibility={{ announcements }}
    >
      <NestTargetContext.Provider value={nestTargetId}>
        <div className="flex gap-4 p-6 overflow-x-auto h-full">
          {phases.map((phase) => (
            <PhaseColumn
              key={phase.id}
              phase={phase}
              onTaskClick={onTaskClick}
              onTaskContextMenu={onTaskContextMenu}
              onEpicClick={onEpicClick}
              onAddTask={onAddTask}
              onInlineCreate={onInlineCreate}
            />
          ))}
        </div>
      </NestTargetContext.Provider>

      <DragOverlay
        dropAnimation={{
          duration: 200,
          easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
        }}
      >
        {activeTask ? <TaskCard task={activeTask} isDragOverlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}
