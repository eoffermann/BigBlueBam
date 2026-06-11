import { clsx, type ClassValue } from 'clsx';
import { format, formatDistanceToNow, isPast, parseISO } from 'date-fns';
import type { Priority, TaskStateCategory } from '@bigbluebam/shared';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return '';
  try {
    return format(parseISO(dateString), 'MMM d, yyyy');
  } catch {
    return dateString;
  }
}

export function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return '';
  try {
    return formatDistanceToNow(parseISO(dateString), { addSuffix: true });
  } catch {
    return dateString;
  }
}

export function isOverdue(dateString: string | null | undefined): boolean {
  if (!dateString) return false;
  try {
    return isPast(parseISO(dateString));
  } catch {
    return false;
  }
}

export function generateAvatarInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0]!.substring(0, 2).toUpperCase();
  }
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// LEGACY FALLBACK: prior to migration 0183 these were the only five
// priorities. The styling for built-in slugs is preserved here so any
// component that hasn't yet wired in `usePriorityMap()` still renders
// sensibly. Per-org custom slugs render via the inline-style helpers
// in `hooks/use-priorities.ts`.
export function priorityColor(priority: Priority): string {
  switch (priority) {
    case 'critical':
      return 'text-priority-critical bg-red-50 border-red-200';
    case 'high':
      return 'text-priority-high bg-orange-50 border-orange-200';
    case 'medium':
      return 'text-priority-medium bg-yellow-50 border-yellow-200';
    case 'low':
      return 'text-priority-low bg-blue-50 border-blue-200';
    case 'none':
      return 'text-priority-none bg-zinc-50 border-zinc-200';
    default:
      return 'text-zinc-500 bg-zinc-50 border-zinc-200';
  }
}

export function priorityIcon(priority: Priority): string {
  switch (priority) {
    case 'critical':
      return 'AlertTriangle';
    case 'high':
      return 'ArrowUp';
    case 'medium':
      return 'Minus';
    case 'low':
      return 'ArrowDown';
    case 'none':
      return 'Minus';
    default:
      return 'Minus';
  }
}

export function stateColor(category: TaskStateCategory): string {
  switch (category) {
    case 'todo':
      return 'bg-state-todo';
    case 'active':
      return 'bg-state-active';
    case 'blocked':
      return 'bg-state-blocked';
    case 'review':
      return 'bg-state-review';
    case 'done':
      return 'bg-state-done';
    case 'cancelled':
      return 'bg-state-cancelled';
    default:
      return 'bg-zinc-400';
  }
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return `${str.substring(0, length)}...`;
}
