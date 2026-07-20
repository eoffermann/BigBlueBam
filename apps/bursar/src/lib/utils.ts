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

// Money is minor units (cents). An absent (suppressed / unrenderable) amount is null|undefined;
// render a neutral placeholder rather than "$0.00", which would read as a real zero. A gap that
// cannot be valued is NOT rendered as a number anywhere (spec 10.2) - callers pass the count
// through separately.
export function formatCents(
  cents: number | null | undefined,
  currency = 'USD',
  placeholder = 'n/a',
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

// A numeric() column arrives as a string; coerce defensively.
export function num(v: string | number | null | undefined, fallback = 0): number {
  if (v == null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? fallback : n;
}
