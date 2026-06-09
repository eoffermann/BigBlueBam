/**
 * Right-click context menu for Bam task cards. Mirrors the
 * three-flavor pattern that Blueprint's editor uses (pane / node / edge):
 * one component, sections gated by what's relevant for the target task.
 *
 * Reachable from a right-click on any task card in BoardView /
 * SwimlaneBoard. The board page owns the state (which task, where on
 * screen) so the menu's actions can reuse the existing useUpdateTask /
 * useDeleteTask / useCreateTask hooks the rest of the board uses.
 *
 * Actions covered:
 *   - Open detail (selects the task and surfaces the existing drawer)
 *   - Add subtask (prompts for a title, POSTs with parent_task_id)
 *   - Duplicate (POST /tasks/:id/duplicate)
 *   - Change parent → submenu listing project tasks; clearing the
 *     parent and replacing it both supported
 *   - Change assignee → submenu of project members + Unassigned
 *   - Change phase → submenu of project phases
 *   - Change state → submenu of project states
 *   - Change priority → critical / high / medium / low / none
 *   - Delete (with confirm)
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task, Priority } from '@bigbluebam/shared';
import {
  Check,
  ChevronRight,
  CopyPlus,
  Eye,
  Flag,
  Layers,
  ListChecks,
  Trash2,
  User,
  UserMinus,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Member {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

interface PhaseRef {
  id: string;
  name: string;
}

interface StateRef {
  id: string;
  name: string;
  category?: string;
}

const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'text-red-600' },
  { value: 'high', label: 'High', color: 'text-orange-500' },
  { value: 'medium', label: 'Medium', color: 'text-yellow-500' },
  { value: 'low', label: 'Low', color: 'text-blue-400' },
  { value: 'none', label: 'None', color: 'text-zinc-400' },
];

export interface TaskContextMenuProps {
  /** Task under the cursor. */
  task: Task;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
  /** Close the menu without doing anything. */
  onClose: () => void;
  /** Project-scoped lists used by the change-* submenus. */
  members: Member[];
  phases: PhaseRef[];
  states: StateRef[];
  /** All sibling tasks in the project, used by the change-parent picker. */
  allTasks: Task[];

  onOpenDetail: (taskId: string) => void;
  onAddSubtask: (parentTaskId: string, title: string) => void;
  onDuplicate: (taskId: string) => void;
  onUpdate: (taskId: string, patch: Partial<Task>) => void;
  onSetParent: (taskId: string, parentTaskId: string | null) => void;
  onDelete: (taskId: string) => void;
}

type Submenu =
  | 'priority'
  | 'phase'
  | 'state'
  | 'assignee'
  | 'parent'
  | null;

export function TaskContextMenu({
  task,
  x,
  y,
  onClose,
  members,
  phases,
  states,
  allTasks,
  onOpenDetail,
  onAddSubtask,
  onDuplicate,
  onUpdate,
  onSetParent,
  onDelete,
}: TaskContextMenuProps) {
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [parentQuery, setParentQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Re-anchor the menu so it never opens past the viewport edge.
  const { left, top } = useMemo(() => {
    if (typeof window === 'undefined') return { left: x, top: y };
    const w = 240;
    const h = 360;
    const padX = 8;
    const padY = 8;
    const overflowRight = x + w + padX > window.innerWidth;
    const overflowBottom = y + h + padY > window.innerHeight;
    return {
      left: overflowRight ? Math.max(padX, window.innerWidth - w - padX) : x,
      top: overflowBottom ? Math.max(padY, window.innerHeight - h - padY) : y,
    };
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Click-away veil + close on outside click.
  function runAndClose(fn: () => void) {
    return () => {
      fn();
      onClose();
    };
  }

  const filteredTasks = useMemo(() => {
    const q = parentQuery.trim().toLowerCase();
    return allTasks
      .filter((t) => t.id !== task.id)
      .filter((t) => {
        if (!q) return true;
        const hay = `${t.title} ${t.human_id ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 30);
  }, [allTasks, parentQuery, task.id]);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-50 w-[240px] max-h-[80vh] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl py-1 text-sm"
        style={{ left, top }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-zinc-400">{task.human_id}</span>
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate flex-1">
              {task.title}
            </span>
          </div>
        </div>

        {/* Primary actions */}
        <MenuItem icon={<Eye className="h-3.5 w-3.5" />} onClick={runAndClose(() => onOpenDetail(task.id))}>
          Open detail
        </MenuItem>
        <MenuItem
          icon={<ListChecks className="h-3.5 w-3.5" />}
          onClick={() => {
            const title = window.prompt('Subtask title:');
            if (title?.trim()) {
              onAddSubtask(task.id, title.trim());
              onClose();
            }
          }}
        >
          Add subtask…
        </MenuItem>
        <MenuItem icon={<CopyPlus className="h-3.5 w-3.5" />} onClick={runAndClose(() => onDuplicate(task.id))}>
          Duplicate
        </MenuItem>

        <Separator />

        <MenuItem
          icon={<Flag className="h-3.5 w-3.5" />}
          onClick={() => setSubmenu(submenu === 'priority' ? null : 'priority')}
          trailingIcon={<ChevronRight className="h-3 w-3" />}
        >
          Priority
        </MenuItem>
        {submenu === 'priority' && (
          <SubmenuPanel>
            {PRIORITIES.map((p) => (
              <MenuItem
                key={p.value}
                onClick={runAndClose(() => onUpdate(task.id, { priority: p.value }))}
                trailing={task.priority === p.value ? <Check className="h-3 w-3 text-primary-600" /> : null}
              >
                <span className={p.color}>•</span> {p.label}
              </MenuItem>
            ))}
          </SubmenuPanel>
        )}

        <MenuItem
          icon={<Layers className="h-3.5 w-3.5" />}
          onClick={() => setSubmenu(submenu === 'phase' ? null : 'phase')}
          trailingIcon={<ChevronRight className="h-3 w-3" />}
        >
          Move to phase
        </MenuItem>
        {submenu === 'phase' && (
          <SubmenuPanel>
            {phases.map((p) => (
              <MenuItem
                key={p.id}
                onClick={runAndClose(() => onUpdate(task.id, { phase_id: p.id }))}
                trailing={task.phase_id === p.id ? <Check className="h-3 w-3 text-primary-600" /> : null}
              >
                {p.name}
              </MenuItem>
            ))}
          </SubmenuPanel>
        )}

        <MenuItem
          icon={<ListChecks className="h-3.5 w-3.5" />}
          onClick={() => setSubmenu(submenu === 'state' ? null : 'state')}
          trailingIcon={<ChevronRight className="h-3 w-3" />}
        >
          Set state
        </MenuItem>
        {submenu === 'state' && (
          <SubmenuPanel>
            {states.map((s) => (
              <MenuItem
                key={s.id}
                onClick={runAndClose(() => onUpdate(task.id, { state_id: s.id }))}
                trailing={task.state_id === s.id ? <Check className="h-3 w-3 text-primary-600" /> : null}
              >
                {s.name}
              </MenuItem>
            ))}
          </SubmenuPanel>
        )}

        <MenuItem
          icon={<User className="h-3.5 w-3.5" />}
          onClick={() => setSubmenu(submenu === 'assignee' ? null : 'assignee')}
          trailingIcon={<ChevronRight className="h-3 w-3" />}
        >
          Assign to…
        </MenuItem>
        {submenu === 'assignee' && (
          <SubmenuPanel>
            <MenuItem
              icon={<UserMinus className="h-3.5 w-3.5" />}
              onClick={runAndClose(() => onUpdate(task.id, { assignee_id: null }))}
              trailing={!task.assignee_id ? <Check className="h-3 w-3 text-primary-600" /> : null}
            >
              Unassigned
            </MenuItem>
            {members.map((m) => (
              <MenuItem
                key={m.id}
                onClick={runAndClose(() => onUpdate(task.id, { assignee_id: m.id }))}
                trailing={task.assignee_id === m.id ? <Check className="h-3 w-3 text-primary-600" /> : null}
              >
                {m.display_name}
              </MenuItem>
            ))}
          </SubmenuPanel>
        )}

        <MenuItem
          icon={<ListChecks className="h-3.5 w-3.5" />}
          onClick={() => setSubmenu(submenu === 'parent' ? null : 'parent')}
          trailingIcon={<ChevronRight className="h-3 w-3" />}
        >
          Change parent task
        </MenuItem>
        {submenu === 'parent' && (
          <SubmenuPanel>
            <div className="px-3 py-1.5">
              <input
                autoFocus
                value={parentQuery}
                onChange={(e) => setParentQuery(e.target.value)}
                placeholder="Search by title or ID…"
                className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <MenuItem
              icon={<X className="h-3.5 w-3.5" />}
              onClick={runAndClose(() => onSetParent(task.id, null))}
              trailing={!task.parent_task_id ? <Check className="h-3 w-3 text-primary-600" /> : null}
            >
              No parent
            </MenuItem>
            {filteredTasks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-400">No matching tasks</div>
            ) : (
              filteredTasks.map((t) => (
                <MenuItem
                  key={t.id}
                  onClick={runAndClose(() => onSetParent(task.id, t.id))}
                  trailing={task.parent_task_id === t.id ? <Check className="h-3 w-3 text-primary-600" /> : null}
                >
                  <span className="font-mono text-[10px] text-zinc-400 mr-1">{t.human_id}</span>
                  <span className="truncate">{t.title}</span>
                </MenuItem>
              ))
            )}
          </SubmenuPanel>
        )}

        <Separator />

        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => {
            if (window.confirm(`Delete "${task.title}"? This is irreversible.`)) {
              onDelete(task.id);
              onClose();
            }
          }}
          destructive
          shortcut="Del"
        >
          Delete task
        </MenuItem>
      </div>
    </>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  trailing,
  trailingIcon,
  destructive,
  shortcut,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  trailing?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  destructive?: boolean;
  shortcut?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs',
        destructive
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 dark:text-red-400'
          : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
      )}
    >
      {icon && <span className="w-4 inline-flex items-center justify-center shrink-0">{icon}</span>}
      <span className="flex-1 truncate flex items-center gap-1">{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
      {shortcut && (
        <span className="shrink-0 font-mono text-[10px] text-zinc-400">{shortcut}</span>
      )}
      {trailingIcon && <span className="shrink-0 text-zinc-400">{trailingIcon}</span>}
    </button>
  );
}

function Separator() {
  return <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />;
}

function SubmenuPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-primary-100 dark:border-primary-900/40 ml-3 my-0.5">
      {children}
    </div>
  );
}
