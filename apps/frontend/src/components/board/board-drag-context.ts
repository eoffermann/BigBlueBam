import { createContext, useContext } from 'react';

/**
 * Carries the id of the task currently being targeted for *nesting* (a drag
 * hovering the vertical-center "sweet spot" of another card) so that card can
 * render its "add as child" affordance. Null when the drag is in a reorder
 * zone or not over a task at all. Set by BoardView during the drag.
 */
export const NestTargetContext = createContext<string | null>(null);

/** True when `taskId` is the card the current drag would nest into on release. */
export function useIsNestTarget(taskId: string): boolean {
  return useContext(NestTargetContext) === taskId;
}
