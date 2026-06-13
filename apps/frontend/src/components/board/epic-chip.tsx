import { cn } from '@/lib/utils';

/**
 * Local epic mini-shape. The shared `Task` type carries `epic_id` but the
 * enriched `epic` object (`{ id, name, color }`) on board/list payloads is
 * being added to `@bigbluebam/shared` separately — until that lands we read
 * it via this local interface and `taskEpic(task)` so frontend tsc stays
 * green independently. RECONCILE: once `Task.epic` exists in shared, drop
 * this interface and the `as any` in `taskEpic` and read `task.epic`.
 */
export interface TaskEpicRef {
  id: string;
  name: string;
  color: string | null;
}

/** Read the (possibly not-yet-typed) `epic` field off a task. */
export function taskEpic(task: unknown): TaskEpicRef | null {
  const epic = (task as { epic?: TaskEpicRef | null } | null)?.epic;
  return epic ?? null;
}

interface EpicChipProps {
  epic: TaskEpicRef;
  onClick?: () => void;
  className?: string;
}

const FALLBACK_COLOR = '#a1a1aa'; // zinc-400

/**
 * Small colored dot + truncated epic name. Clicking navigates to the epic
 * detail route (the caller wires onClick). Pointer events are stopped so the
 * chip never starts a card drag or opens the task drawer.
 */
export function EpicChip({ epic, onClick, className }: EpicChipProps) {
  return (
    <button
      type="button"
      title={`Epic: ${epic.name}`}
      aria-label={`Epic ${epic.name}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn(
        'inline-flex items-center gap-1 min-w-0 max-w-[140px] rounded px-1 leading-4',
        'text-[10px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500',
        className,
      )}
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: epic.color ?? FALLBACK_COLOR }}
      />
      <span className="truncate">{epic.name}</span>
    </button>
  );
}
