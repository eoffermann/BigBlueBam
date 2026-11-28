// `asker_user_id` on detail-bearing reads (spec 2.8, 5.4; #217): when an agent reads for a person,
// the answer is the INTERSECTION of what the bearer and the asker may see. It narrows, never
// widens (the bursar-tools.ts rule). A malformed value is refused rather than ignored, so a typo
// never silently returns the bearer's wider view.

import type { Viewer } from '../services/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function askerUserIdOf(query: unknown): string | 'invalid' | null {
  const raw = (query as { asker_user_id?: unknown } | undefined)?.asker_user_id;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) return 'invalid';
  return raw.toLowerCase();
}

/** can_access(asker, entity_type, entity_id), as bastion-api calls it. */
export type ReaderCanAccess = (askerUserId: string, entityType: string, entityId: string) => Promise<boolean>;

/**
 * The ONE place a cited record's visibility is decided for a reader (#414): can_access for the
 * viewer and, when an agent reads for a person (viewer.asker_id), for the asker too. Every
 * citation and population-name filter goes through here, so asker narrowing cannot be wired into
 * one read and forgotten in the next. Fail closed: an error from either check is a refusal.
 */
export async function readersMay(canAccess: ReaderCanAccess, viewer: Viewer, accessType: string, entityId: string): Promise<boolean> {
  if (!(await canAccess(viewer.id, accessType, entityId).catch(() => false))) return false;
  if (!viewer.asker_id || viewer.asker_id === viewer.id) return true;
  return canAccess(viewer.asker_id, accessType, entityId).catch(() => false);
}
