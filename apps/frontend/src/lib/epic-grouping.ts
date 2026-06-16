/**
 * Shared epic-grouping helpers used by the board swimlanes, the list view,
 * and the timeline view so "group by epic" behaves identically everywhere:
 * the highest-priority task is promoted to the group header, and the groups
 * sort by priority or name in either direction.
 */
import type { Task } from '@bigbluebam/shared';
import type { Priority } from '@/hooks/use-priorities';

export type LaneSort =
  | 'priority-desc'
  | 'priority-asc'
  | 'alpha-asc'
  | 'alpha-desc'
  | 'start-asc'
  | 'start-desc'
  | 'end-asc'
  | 'end-desc';

/** Sort options offered on the board swimlanes and list view. */
export const LANE_SORT_OPTIONS: { value: LaneSort; label: string }[] = [
  { value: 'priority-desc', label: 'Priority (high → low)' },
  { value: 'priority-asc', label: 'Priority (low → high)' },
  { value: 'alpha-asc', label: 'Name (A → Z)' },
  { value: 'alpha-desc', label: 'Name (Z → A)' },
];

/** Date-range sorts — only meaningful where groups carry date bounds (the
 *  timeline), so they live in a separate list rather than LANE_SORT_OPTIONS. */
const DATE_SORT_OPTIONS: { value: LaneSort; label: string }[] = [
  { value: 'start-asc', label: 'Start date (earliest → latest)' },
  { value: 'start-desc', label: 'Start date (latest → earliest)' },
  { value: 'end-asc', label: 'End date (earliest → latest)' },
  { value: 'end-desc', label: 'End date (latest → earliest)' },
];

/** The timeline offers the standard sorts plus the start/end-date sorts. */
export const TIMELINE_SORT_OPTIONS: { value: LaneSort; label: string }[] = [
  ...LANE_SORT_OPTIONS,
  ...DATE_SORT_OPTIONS,
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
  /**
   * Epoch ms of the group's earliest task start / latest task end, for the
   * date sorts. Null when no task in the group carries a date. Optional so the
   * board/list callers (which only offer priority/name sorts) need not compute
   * them — those callers never pass a date mode, so the fields go unused there.
   */
  startMs?: number | null;
  endMs?: number | null;
}

/**
 * Earliest task start and latest task end across a group, as epoch ms — used
 * for the timeline's start/end-date sorts and its collapsed summary bar. A
 * task's effective start is its start_date (falling back to due_date); its
 * effective end is its due_date (falling back to start_date), mirroring the
 * range the timeline draws for each bar. Returns null bounds when no task in
 * the group carries a date.
 */
export function groupDateBounds(tasks: Task[]): { startMs: number | null; endMs: number | null } {
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const t of tasks) {
    const s = (t as Task & { start_date?: string | null }).start_date ?? null;
    const e = t.due_date ?? null;
    const startStr = s ?? e;
    const endStr = e ?? s;
    if (startStr) {
      const ms = Date.parse(startStr);
      if (!Number.isNaN(ms) && (startMs === null || ms < startMs)) startMs = ms;
    }
    if (endStr) {
      const ms = Date.parse(endStr);
      if (!Number.isNaN(ms) && (endMs === null || ms > endMs)) endMs = ms;
    }
  }
  return { startMs, endMs };
}

/**
 * Sort epic/lane groups by the chosen mode. Sentinel groups (No Epic, etc.)
 * always trail. Priority modes break ties alphabetically so the order is
 * stable and readable.
 */
export function sortGroups<T extends SortableGroup>(groups: T[], mode: LaneSort): T[] {
  const alpha = (a: T, b: T) => a.label.localeCompare(b.label);
  // Compare two nullable epoch-ms values. Groups with no date (null) always
  // sort LAST regardless of direction; real dates break ties alphabetically.
  const byDate = (a: T, b: T, pick: (g: T) => number | null | undefined, dir: 1 | -1) => {
    const av = pick(a) ?? null;
    const bv = pick(b) ?? null;
    if (av === null && bv === null) return alpha(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * dir || alpha(a, b);
  };
  return groups.slice().sort((a, b) => {
    const aTrail = TRAILING_KEYS.has(a.key);
    const bTrail = TRAILING_KEYS.has(b.key);
    if (aTrail !== bTrail) return aTrail ? 1 : -1;
    switch (mode) {
      case 'alpha-asc':
        return alpha(a, b);
      case 'alpha-desc':
        return -alpha(a, b);
      case 'start-asc':
        return byDate(a, b, (g) => g.startMs, 1);
      case 'start-desc':
        return byDate(a, b, (g) => g.startMs, -1);
      case 'end-asc':
        return byDate(a, b, (g) => g.endMs, 1);
      case 'end-desc':
        return byDate(a, b, (g) => g.endMs, -1);
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
