/**
 * Per-project board view + filter persistence.
 *
 * The board page (apps/frontend/src/pages/board.tsx) used to drop the active
 * view, filters, swimlane grouping, and lane sort whenever the user navigated
 * away and came back (component-local useState, reset to defaults on every
 * projectId change). This stores the last-used board preferences per project in
 * localStorage so they survive navigation and reloads, and re-applies them on
 * return until the user clicks "Reset Filters".
 *
 * Keyed by projectId so each project remembers its own view independently.
 * Best-effort: any storage failure (quota, private mode, SSR) is swallowed and
 * treated as "no saved prefs", so the board always renders.
 */

export interface BoardPrefs {
  /** Filter set: priority / assignee_id / state_id / epic_id / search (comma-joined multi-selects). */
  filters: Record<string, string | undefined>;
  /** Active view: board | list | timeline | calendar | workload. */
  viewMode: string;
  /** Swimlane grouping: none | assignee | priority | epic. */
  swimlane: string;
  /** Lane sort (only meaningful when grouping by epic), e.g. priority-desc. */
  laneSort: string;
}

export const BOARD_PREF_DEFAULTS: BoardPrefs = {
  filters: {},
  viewMode: 'board',
  swimlane: 'none',
  laneSort: 'priority-desc',
};

const keyFor = (projectId: string) => `bam:boardPrefs:v1:${projectId}`;

/** Load saved prefs for a project, falling back to defaults. Never throws. */
export function loadBoardPrefs(projectId: string): BoardPrefs {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return { ...BOARD_PREF_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BoardPrefs>;
    return {
      ...BOARD_PREF_DEFAULTS,
      ...parsed,
      // filters must always be an object so the board's filter reads are safe.
      filters:
        parsed.filters && typeof parsed.filters === 'object' ? parsed.filters : {},
    };
  } catch {
    return { ...BOARD_PREF_DEFAULTS };
  }
}

/** Merge a partial update into the stored prefs for a project. Never throws. */
export function saveBoardPrefs(projectId: string, partial: Partial<BoardPrefs>): void {
  try {
    const next = { ...loadBoardPrefs(projectId), ...partial };
    localStorage.setItem(keyFor(projectId), JSON.stringify(next));
  } catch {
    // ignore quota / private-mode / SSR failures
  }
}

/** Reset just the filter/grouping bits to defaults; leaves the chosen view. */
export function resetBoardFilters(projectId: string): void {
  saveBoardPrefs(projectId, {
    filters: {},
    swimlane: BOARD_PREF_DEFAULTS.swimlane,
    laneSort: BOARD_PREF_DEFAULTS.laneSort,
  });
}
