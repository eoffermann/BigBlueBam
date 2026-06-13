/**
 * Shared epic-grouping helpers used by the board swimlanes, the list view,
 * and the timeline view so "group by epic" behaves identically everywhere:
 * the highest-priority task is promoted to the group header, and the groups
 * sort by priority or name in either direction.
 */
import type { Task } from '@bigbluebam/shared';
import type { Priority } from '@/hooks/use-priorities';

export type LaneSort = 'priority-desc' | 'priority-asc' | 'alpha-asc' | 'alpha-desc';

export const LANE_SORT_OPTIONS: { value: LaneSort; label: string }[] = [
  { value: 'priority-desc', label: 'Priority (high → low)' },
  { value: 'priority-asc', label: 'Priority (low → high)' },
  { value: 'alpha-asc', label: 'Name (A → Z)' },
  { value: 'alpha-desc', label: 'Name (Z → A)' },
];

/** Sentinel group keys that always sort to the bottom regardless of mode. */
const TRAILING_KEYS = new Set(['__no_epic__', '__unassigned__', '__all__', '__none__']);

/** Read the nested enriched epic object (board/list payload). */
export function taskEpicRef(task: Task): { id: string; name: string; color: string | null } | null {
  return (task as Task & { epic?: { id: string; name: string; color: string | null } | null })
    .epic ?? null;
}

/**
 * Position of the HIGHEST-priority task in the set (lowest catalog position
 * wins; position 0 is the top priority). Returns Infinity when no task has a
 * known priority, so empty/none groups sort last under priority order.
 */
export function topPriorityPosition(tasks: Task[], posByValue: Map<string, number>): number {
  let best = Number.POSITIVE_INFINITY;
  for (const t of tasks) {
    const p = posByValue.get(t.priority);
    if (p != null && p < best) best = p;
  }
  return best;
}

/** The Priority catalog row to badge a group with (its top task's priority). */
export function topPriority(tasks: Task[], catalog: Priority[]): Priority | null {
  const byValue = new Map(catalog.map((p) => [p.value, p]));
  let best: Priority | null = null;
  for (const t of tasks) {
    const p = byValue.get(t.priority);
    if (p && (best === null || p.position < best.position)) best = p;
  }
  return best;
}

export interface SortableGroup {
  key: string;
  label: string;
  topPriorityPos: number;
}

/**
 * Sort epic/lane groups by the chosen mode. Sentinel groups (No Epic, etc.)
 * always trail. Priority modes break ties alphabetically so the order is
 * stable and readable.
 */
export function sortGroups<T extends SortableGroup>(groups: T[], mode: LaneSort): T[] {
  const alpha = (a: T, b: T) => a.label.localeCompare(b.label);
  return groups.slice().sort((a, b) => {
    const aTrail = TRAILING_KEYS.has(a.key);
    const bTrail = TRAILING_KEYS.has(b.key);
    if (aTrail !== bTrail) return aTrail ? 1 : -1;
    switch (mode) {
      case 'alpha-asc':
        return alpha(a, b);
      case 'alpha-desc':
        return -alpha(a, b);
      // Catalog position 0 is the HIGHEST priority, so "high → low" is
      // position ascending and "low → high" is position descending.
      case 'priority-asc':
        return b.topPriorityPos - a.topPriorityPos || alpha(a, b);
      case 'priority-desc':
      default:
        return a.topPriorityPos - b.topPriorityPos || alpha(a, b);
    }
  });
}
