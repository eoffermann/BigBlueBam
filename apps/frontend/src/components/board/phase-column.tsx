import { useState, useRef } from 'react';
import { useDroppable, useDndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus } from 'lucide-react';
import type { Phase, Task } from '@bigbluebam/shared';
import { cn } from '@/lib/utils';
import { TaskCard } from './task-card';
import { InlineTaskInput } from './inline-task-input';

interface PhaseColumnProps {
  phase: Phase & { tasks: Task[] };
  onTaskClick: (taskId: string) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onEpicClick?: (epicId: string) => void;
  onAddTask: (phaseId: string) => void;
  onInlineCreate?: (phaseId: string, title: string) => Promise<void>;
  /** Disambiguates the droppable id when the same phase is rendered in
   *  multiple swimlanes — without it every lane's column shares one
   *  droppable id and dnd-kit only registers one, breaking cross-status
   *  drag in all but one lane. The drag handler still reads the real
   *  phaseId from the droppable's data. */
  laneKey?: string;
}

// Threshold at which virtualization activates. Below this, render the column
// normally so the common case (small boards) keeps all animations and does
// not pay the virtualization overhead.
const VIRTUALIZE_THRESHOLD = 50;
// Approximate task card height including gap (used as the virtualizer's
// initial estimate; dynamic measurement refines it after mount).
const ESTIMATED_CARD_HEIGHT = 104;
const CARD_GAP = 8;

export function PhaseColumn({ phase, onTaskClick, onTaskContextMenu, onEpicClick, onAddTask, onInlineCreate, laneKey }: PhaseColumnProps) {
  const [isCreating, setIsCreating] = useState(false);
  const { setNodeRef, isOver } = useDroppable({
    id: laneKey ? `phase-${laneKey}-${phase.id}` : `phase-${phase.id}`,
    data: { type: 'phase', phaseId: phase.id },
  });

  const taskCount = phase.tasks.length;
  const isOverWip = phase.wip_limit != null && taskCount > phase.wip_limit;
  const taskIds = phase.tasks.map((t) => t.id);
  const shouldVirtualize = taskCount >= VIRTUALIZE_THRESHOLD;

  return (
    <div
      data-testid="phase-column"
      data-phase-id={phase.id}
      className={cn(
        'flex flex-col w-72 shrink-0 rounded-xl bg-zinc-100/80 dark:bg-zinc-900/50 transition-all duration-150',
        isOver && 'ring-2 ring-primary-400 bg-primary-50/50 dark:bg-zinc-800/20 scale-[1.005]',
      )}
    >
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2">
          {phase.color && (
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: phase.color }} />
          )}
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">{phase.name}</h3>
          <span
            className={cn(
              'inline-flex items-center justify-center h-5 min-w-[20px] rounded-full text-xs font-medium px-1.5',
              isOverWip
                ? 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400'
                : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
            )}
          >
            {taskCount}
            {phase.wip_limit != null && `/${phase.wip_limit}`}
          </span>
        </div>
        <button
          onClick={() => {
            if (onInlineCreate) {
              setIsCreating(true);
            } else {
              onAddTask(phase.id);
            }
          }}
          className="rounded-md p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
          aria-label={`Add task to ${phase.name}`}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {shouldVirtualize ? (
        <VirtualTaskList
          phase={phase}
          taskIds={taskIds}
          setNodeRef={setNodeRef}
          onTaskClick={onTaskClick}
          onTaskContextMenu={onTaskContextMenu}
          onEpicClick={onEpicClick}
          isCreating={isCreating}
          onInlineCreate={onInlineCreate}
          onCancelCreate={() => setIsCreating(false)}
        />
      ) : (
        <div
          ref={setNodeRef}
          className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2 space-y-2 min-h-[100px] max-h-[calc(100vh-220px)]"
        >
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            {phase.tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => onTaskClick(task.id)}
                onContextMenu={onTaskContextMenu}
                onEpicClick={onEpicClick}
              />
            ))}
          </SortableContext>

          {phase.tasks.length === 0 && !isCreating && (
            <div className="flex items-center justify-center h-20 rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 text-sm text-zinc-400">
              No tasks
            </div>
          )}

          {isCreating && onInlineCreate && (
            <InlineTaskInput
              onSubmit={async (title) => {
                await onInlineCreate(phase.id, title);
              }}
              onCancel={() => setIsCreating(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface VirtualTaskListProps {
  phase: Phase & { tasks: Task[] };
  taskIds: string[];
  setNodeRef: (el: HTMLElement | null) => void;
  onTaskClick: (taskId: string) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onEpicClick?: (epicId: string) => void;
  isCreating: boolean;
  onInlineCreate?: (phaseId: string, title: string) => Promise<void>;
  onCancelCreate: () => void;
}

/**
 * Virtualized task list used for columns above VIRTUALIZE_THRESHOLD tasks.
 * Renders only the visible window plus overscan. To keep dnd-kit happy while
 * dragging, the actively-dragged task (if it belongs to this column) is
 * force-rendered even when it sits outside the virtual window — otherwise
 * dnd-kit would lose its DOM node mid-drag and the drop would fail.
 */
function VirtualTaskList({
  phase,
  taskIds,
  setNodeRef,
  onTaskClick,
  onTaskContextMenu,
  onEpicClick,
  isCreating,
  onInlineCreate,
  onCancelCreate,
}: VirtualTaskListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { active } = useDndContext();
  const activeId = active?.id != null ? String(active.id) : null;

  const virtualizer = useVirtualizer({
    count: phase.tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT + CARD_GAP,
    overscan: 5,
    getItemKey: (index) => phase.tasks[index]?.id ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // If the actively-dragged task belongs to this column but is outside the
  // visible window, mount it off-screen so dnd-kit's sortable context keeps
  // its DOM reference alive through the drag.
  const activeIndex =
    activeId != null ? phase.tasks.findIndex((t) => t.id === activeId) : -1;
  const activeIsInWindow =
    activeIndex !== -1 && virtualItems.some((v) => v.index === activeIndex);
  const activeTaskOutOfWindow =
    activeIndex !== -1 && !activeIsInWindow ? phase.tasks[activeIndex] : null;

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        setNodeRef(el);
      }}
      className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2 min-h-[100px] max-h-[calc(100vh-220px)]"
    >
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          style={{
            height: `${totalSize}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const task = phase.tasks[virtualRow.index];
            if (!task) return null;
            return (
              <div
                key={task.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingBottom: `${CARD_GAP}px`,
                }}
              >
                <TaskCard
                  task={task}
                  onClick={() => onTaskClick(task.id)}
                  onContextMenu={onTaskContextMenu}
                  onEpicClick={onEpicClick}
                />
              </div>
            );
          })}
        </div>
        {activeTaskOutOfWindow && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 1,
              height: 1,
              overflow: 'hidden',
              opacity: 0,
              pointerEvents: 'none',
            }}
          >
            <TaskCard task={activeTaskOutOfWindow} />
          </div>
        )}
      </SortableContext>

      {isCreating && onInlineCreate && (
        <div className="pt-2">
          <InlineTaskInput
            onSubmit={async (title) => {
              await onInlineCreate(phase.id, title);
            }}
            onCancel={onCancelCreate}
          />
        </div>
      )}
    </div>
  );
}
