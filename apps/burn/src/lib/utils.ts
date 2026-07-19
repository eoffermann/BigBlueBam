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

// Money is minor units (cents) throughout the Burn API. Absent (floored/suppressed) money
// is null|undefined; render a neutral placeholder rather than "$0.00", which would read as
// a real zero.
export function formatCents(
  cents: number | null | undefined,
  currency = 'USD',
  placeholder = '—',
): string {
  if (cents == null || Number.isNaN(cents)) return placeholder;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)} ${currency}`;
  }
}

// Percentages arrive as numbers with up to two decimals (numeric(6,2)); e.g. 62.5 -> "62.5%".
export function formatPct(value: number | null | undefined, placeholder = '—'): string {
  if (value == null || Number.isNaN(value)) return placeholder;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

// Clamp a percentage into [0, 100] for a progress bar width.
export function clampPct(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
