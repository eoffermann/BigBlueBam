/**
 * Small shared bits for the epic-grouped views (swimlane board, list,
 * timeline): the promoted-priority badge shown on a group header, and the
 * right-click "collapse all / expand all" context menu.
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import type { Priority } from '@/hooks/use-priorities';

/** Colored dot + name for the highest priority promoted to a group header. */
export function EpicPriorityBadge({ priority }: { priority: Priority | null }) {
  if (!priority) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:text-zinc-300"
      title={`Top priority in this group: ${priority.name}`}
    >
      <span
        className="h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: priority.color || '#a1a1aa' }}
      />
      {priority.name}
    </span>
  );
}

interface CollapseAllMenuProps {
  x: number;
  y: number;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onClose: () => void;
}

/**
 * Fixed-position right-click menu with Collapse all / Expand all. Portaled
 * to the body so it escapes any overflow-clipping ancestor; closes on
 * outside click, scroll, or Escape.
 */
export function CollapseAllMenu({ x, y, onCollapseAll, onExpandAll, onClose }: CollapseAllMenuProps) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer so the opening right-click doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item =
    'flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800';

  return createPortal(
    <div
      role="menu"
      className="fixed z-[100] min-w-[160px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-1"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" className={item} onClick={() => { onCollapseAll(); onClose(); }}>
        <ChevronsDownUp className="h-4 w-4 text-zinc-400" />
        Collapse all
      </button>
      <button type="button" className={item} onClick={() => { onExpandAll(); onClose(); }}>
        <ChevronsUpDown className="h-4 w-4 text-zinc-400" />
        Expand all
      </button>
    </div>,
    document.body,
  );
}
