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
import { useMoveTask } from '@/hooks/use-tasks';
import { ApiError } from '@/lib/api';
import { PhaseColumn } from './phase-column';
import { TaskCard } from './task-card';

interface BoardViewProps {
  phases: (Phase & { tasks: Task[] })[];
  onTaskClick: (taskId: string) => void;
  onAddTask: (phaseId: string) => void;
  onInlineCreate?: (phaseId: string, title: string) => Promise<void>;
}

export function BoardView({ phases, onTaskClick, onAddTask, onInlineCreate }: BoardViewProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const moveTaskInStore = useBoardStore((s) => s.moveTask);
  const moveTaskMutation = useMoveTask();

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

  const handleDragOver = (_event: DragOverEvent) => {
    // DragOverlay handles the visual feedback
  };

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
      accessibility={{ announcements }}
    >
      <div className="flex gap-4 p-6 overflow-x-auto h-full">
        {phases.map((phase) => (
          <PhaseColumn
            key={phase.id}
            phase={phase}
            onTaskClick={onTaskClick}
            onAddTask={onAddTask}
            onInlineCreate={onInlineCreate}
          />
        ))}
      </div>

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
