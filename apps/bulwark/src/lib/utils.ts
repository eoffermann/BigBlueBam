import { clsx, type ClassValue } from 'clsx';
import { format, formatDistanceToNow, parseISO } from 'date-fns';

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

export function formatDateTime(dateString: string | null | undefined): string {
  if (!dateString) return '';
  try {
    return format(parseISO(dateString), 'MMM d, yyyy h:mm a');
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

// A compact human countdown to a future timestamp, e.g. "in 3d 4h", "in 5h", "overdue by 2d".
export function formatCountdown(dueAt: string | null | undefined): { label: string; overdue: boolean } {
  if (!dueAt) return { label: '', overdue: false };
  let due: Date;
  try {
    due = parseISO(dueAt);
  } catch {
    return { label: dueAt, overdue: false };
  }
  const now = Date.now();
  const diffMs = due.getTime() - now;
  const overdue = diffMs < 0;
  const abs = Math.abs(diffMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const mins = Math.floor((abs % 3_600_000) / 60_000);
  let core: string;
  if (days > 0) core = `${days}d ${hours}h`;
  else if (hours > 0) core = `${hours}h ${mins}m`;
  else core = `${mins}m`;
  return { label: overdue ? `overdue by ${core}` : `in ${core}`, overdue };
}
