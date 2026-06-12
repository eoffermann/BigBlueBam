import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { motion } from 'motion/react';
import {
  MessageSquare,
  Paperclip,
  Calendar,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
  RotateCcw,
  Headset,
} from 'lucide-react';
import type { Task, Priority } from '@bigbluebam/shared';
import { cn, formatDate, isOverdue, truncate } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

interface TaskCardProps {
  task: Task;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
  isDragOverlay?: boolean;
}

function PriorityIcon({ priority }: { priority: Priority }) {
  switch (priority) {
    case 'critical':
      return <AlertTriangle className="h-3.5 w-3.5 text-red-600" />;
    case 'high':
      return <ArrowUp className="h-3.5 w-3.5 text-orange-500" />;
    case 'medium':
      return <Minus className="h-3.5 w-3.5 text-yellow-500" />;
    case 'low':
      return <ArrowDown className="h-3.5 w-3.5 text-blue-400" />;
    default:
      return null;
  }
}

/**
 * Parent-task badges on subtask cards: up to two parent ids inline, then a
 * `…` chip whose hover/click popover lists every parent (multi-parent
 * tasks are rare but legal — parents depend on shared subtasks).
 * Pointer events are stopped so the chip neither opens the task nor
 * starts a drag.
 */
function ParentBadges({ parents }: { parents: { id: string; human_id: string | null }[] }) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  if (parents.length === 0) return null;
  const shown = parents.slice(0, 2);
  const overflow = parents.slice(2);
  return (
    <span className="flex items-center gap-1 min-w-0" title="Parent tasks">
      <span aria-hidden className="text-[10px] text-zinc-400">↑</span>
      {shown.map((p) => (
        <span
          key={p.id}
          className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded px-1 leading-4 truncate max-w-[72px]"
        >
          {p.human_id ?? p.id.slice(0, 6)}
        </span>
      ))}
      {overflow.length > 0 && (
        <span
          className="relative"
          onMouseEnter={() => setOverflowOpen(true)}
          onMouseLeave={() => setOverflowOpen(false)}
        >
          <button
            type="button"
            className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 rounded px-1 leading-4 hover:bg-zinc-200 dark:hover:bg-zinc-700"
            aria-label={`Show all ${parents.length} parent tasks`}
            aria-expanded={overflowOpen}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setOverflowOpen((v) => !v);
            }}
          >
            …
          </button>
          {overflowOpen && (
            <span
              className="absolute left-0 top-full mt-1 z-30 min-w-[120px] max-w-[200px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1 px-2 flex flex-col gap-0.5"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[9px] uppercase tracking-wide text-zinc-400">
                Parent tasks
              </span>
              {parents.map((p) => (
                <span
                  key={p.id}
                  className="text-[11px] font-mono text-zinc-600 dark:text-zinc-300 whitespace-nowrap"
                >
                  {p.human_id ?? p.id.slice(0, 8)}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function TaskCard({ task, onClick, onContextMenu, isDragOverlay = false }: TaskCardProps) {
  const prefersReducedMotion = useReducedMotion();

  const sortable = useSortable({
    id: task.id,
    data: { type: 'task', task },
    disabled: isDragOverlay,
  });

  const style = !isDragOverlay
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }
    : undefined;

  const overdue = isOverdue(task.due_date);
  const hasSubtasks = task.subtask_count > 0;
  const subtaskProgress = hasSubtasks
    ? Math.round((task.subtask_done_count / task.subtask_count) * 100)
    : 0;

  return (
    <motion.div
      data-testid="task-card"
      data-task-id={task.id}
      ref={!isDragOverlay ? sortable.setNodeRef : undefined}
      style={style}
      {...(!isDragOverlay ? { ...sortable.attributes, ...sortable.listeners } : {})}
      layout={!isDragOverlay}
      initial={!isDragOverlay ? { opacity: 0, y: prefersReducedMotion ? 0 : -8 } : false}
      animate={
        isDragOverlay
          ? { scale: 1.03, boxShadow: '0 12px 24px rgba(0,0,0,0.15)', rotate: 1 }
          : { opacity: 1, y: 0, scale: 1, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', rotate: 0 }
      }
      exit={{ opacity: 0, scale: 0.95, y: prefersReducedMotion ? 0 : 8 }}
      whileHover={!isDragOverlay && !prefersReducedMotion ? { y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' } : undefined}
      transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 25, stiffness: 300 }}
      className={cn(
        'rounded-lg border bg-white p-3 cursor-grab active:cursor-grabbing',
        'dark:bg-zinc-900 dark:border-zinc-800',
        sortable.isDragging && !isDragOverlay && 'opacity-30',
      )}
      onClick={!isDragOverlay ? onClick : undefined}
      onContextMenu={
        !isDragOverlay && onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e, task);
            }
          : undefined
      }
    >
      {/* Row 1: State dot, Human ID, Priority, Carry-forward */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="h-2 w-2 rounded-full shrink-0 bg-blue-500" />
        <span className="text-xs font-mono text-zinc-400">{task.human_id}</span>
        <ParentBadges parents={task.parents ?? []} />
        {task.priority !== 'none' && <PriorityIcon priority={task.priority} />}
        {task.carry_forward_count > 0 && (
          <span className="flex items-center gap-0.5 text-xs text-orange-500" title={`Carried forward ${task.carry_forward_count} time(s)`}>
            <RotateCcw className="h-3 w-3" />
            {task.carry_forward_count}
          </span>
        )}
        {Boolean(task.custom_fields?.helpdesk_ticket_id) && (
          <span title={`Ticket #${String(task.custom_fields.helpdesk_ticket_number ?? '')}`}>
            <Headset className="h-3 w-3 text-purple-500" />
          </span>
        )}
      </div>

      {/* Row 2: Title */}
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug mb-2">
        {truncate(task.title, 80)}
      </p>

      {/* Row 3: Metadata */}
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          {task.story_points != null && (
            <span className="inline-flex items-center justify-center h-5 min-w-[20px] rounded bg-zinc-100 dark:bg-zinc-800 px-1 font-medium text-zinc-600 dark:text-zinc-400">
              {task.story_points}
            </span>
          )}
          {task.due_date && (
            <span className={cn('flex items-center gap-1', overdue && 'text-red-600 font-medium')}>
              <Calendar className="h-3 w-3" />
              {formatDate(task.due_date)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {hasSubtasks && (
            <span className="flex items-center gap-1" title={`${task.subtask_done_count}/${task.subtask_count} subtasks`}>
              <div className="w-10 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary-500 transition-all"
                  style={{ width: `${subtaskProgress}%` }}
                />
              </div>
            </span>
          )}
          {task.comment_count > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageSquare className="h-3 w-3" />
              {task.comment_count}
            </span>
          )}
          {task.attachment_count > 0 && (
            <span className="flex items-center gap-0.5">
              <Paperclip className="h-3 w-3" />
              {task.attachment_count}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
