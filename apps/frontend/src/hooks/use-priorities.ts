/**
 * Per-org task priority hook + helpers (Task 3 / configurable
 * priorities). Replaces the hardcoded PRIORITIES enum and the
 * priorityColor / priorityIcon utilities in src/lib/utils.ts. The
 * shape returned by the API matches packages/shared's hex-color +
 * Lucide-icon-name convention.
 *
 * The list is cached at module scope keyed on the active org so the
 * value-map editor, swimlane sort, task drawer, filter bar, and any
 * other display can pull from a single source of truth instead of
 * each duplicating the legacy switch statements.
 */
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiResponse } from '@bigbluebam/shared';
import { api } from '@/lib/api';

export interface Priority {
  id: string;
  org_id: string;
  value: string;
  name: string;
  color: string;
  icon: string | null;
  position: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreatePriorityInput {
  name: string;
  value?: string;
  color: string;
  icon?: string | null;
  position?: number;
  is_default?: boolean;
}

export type UpdatePriorityInput = Partial<CreatePriorityInput>;

const PRIORITIES_KEY = ['priorities'] as const;

export function usePriorities() {
  return useQuery({
    queryKey: PRIORITIES_KEY,
    queryFn: () => api.get<ApiResponse<Priority[]>>('/priorities'),
    // The catalog rarely changes within a session; 5-minute stale is
    // a friendly default. Manual mutations invalidate via the
    // mutation hooks below.
    staleTime: 5 * 60_000,
  });
}

/**
 * Build a lookup map keyed by `value` plus the default row's value.
 * Stable across renders so consumers can pass it into deps lists
 * without re-rendering everything when a different field changes.
 */
export function usePriorityMap(): {
  byValue: Map<string, Priority>;
  defaultValue: string | null;
  ordered: Priority[];
  isLoading: boolean;
} {
  const { data, isLoading } = usePriorities();
  return useMemo(() => {
    const rows = data?.data ?? [];
    const byValue = new Map<string, Priority>();
    let defaultValue: string | null = null;
    for (const row of rows) {
      byValue.set(row.value, row);
      if (row.is_default) defaultValue = row.value;
    }
    const ordered = [...rows].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    return { byValue, defaultValue, ordered, isLoading };
  }, [data, isLoading]);
}

/**
 * Cosmetic helpers. Given a slug, produce a Tailwind-compatible class
 * string or a Lucide icon name. Both gracefully fall back when the
 * row has been deleted from under the data — a dropped priority
 * value still has a sensible muted rendering.
 */
export function priorityClassesFromRow(row: Priority | undefined): string {
  if (!row) return 'text-zinc-500 bg-zinc-50 border-zinc-200';
  // Inline style is the right call here because the color is
  // arbitrary hex. We build the class string so callers can still
  // compose with cn().
  return 'border';
}

export function priorityInlineStyle(row: Priority | undefined): React.CSSProperties {
  if (!row) return { color: '#71717a', backgroundColor: '#fafafa', borderColor: '#e4e4e7' };
  // Compose foreground + a 10% tinted background. This gives every
  // priority a consistent visual weight regardless of the chosen
  // hex.
  return {
    color: row.color,
    backgroundColor: `${row.color}1A`, // ~10% alpha
    borderColor: `${row.color}40`,     // ~25% alpha
  };
}

/**
 * Map a stored slug to a Lucide icon name, falling back to 'Minus'
 * when the row is missing or no icon is configured. Lucide names are
 * PascalCase; the DB stores kebab-case, so we convert.
 */
export function priorityIconNameFromRow(row: Priority | undefined): string {
  if (!row?.icon) return 'Minus';
  return row.icon
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function useCreatePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePriorityInput) =>
      api.post<ApiResponse<Priority>>('/priorities', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: PRIORITIES_KEY }),
  });
}

export function useUpdatePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdatePriorityInput }) =>
      api.patch<ApiResponse<Priority>>(`/priorities/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: PRIORITIES_KEY }),
  });
}

export function useDeletePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, migrate_to }: { id: string; migrate_to?: string }) =>
      api.delete<ApiResponse<{ success: boolean; tasks_migrated: number }>>(
        migrate_to
          ? `/priorities/${id}?migrate_to=${encodeURIComponent(migrate_to)}`
          : `/priorities/${id}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PRIORITIES_KEY });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useReorderPriorities() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<ApiResponse<Priority[]>>('/priorities/reorder', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PRIORITIES_KEY }),
  });
}
