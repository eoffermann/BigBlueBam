/**
 * Bureau DND (Do Not Disturb) status check (Agent B, workstream 5).
 *
 * Spec: docs/plans/bureau-design-document.md §4.3 — when a visitor knocks on
 * an office door we must first check whether the OWNER is currently in DND
 * mode. If they are, we never persist a `bureau_knocks` row; instead the
 * visitor receives an immediate 423 Locked (REST) or `knock_resolved`
 * with `decision: 'dnd_blocked'` (WS) so they can offer to leave a note.
 *
 * DND model (§7):
 *   A user can have several active sessions (web + pip + desktop). DND is
 *   per-session — a user is considered DND for door-knock purposes if ANY
 *   of their live sessions reports `status === 'dnd'`. Rationale: a user
 *   focused on their desktop client with DND on does not want a knock to
 *   surface from their forgotten browser tab session. Once any session
 *   flips into DND, every knock is blocked until every session leaves DND.
 *
 * Implementation:
 *   1. SMEMBERS `bureau:user:{userId}:sessions` to get the list of live
 *      session ids.
 *   2. Pipeline HGET `bureau:sess:{sessionId}` 'status' for each.
 *   3. Return true if any value === 'dnd'.
 *
 * A stale session (TTL lapsed but not yet swept by the reaper) returns nil
 * from HGET and is treated as not-DND, which is the safe default — we'd
 * rather a borderline-stale session NOT block a knock than have one block
 * a knock indefinitely.
 */

import type Redis from 'ioredis';

const SESSION_KEY = (sessionId: string) => `bureau:sess:${sessionId}`;
const USER_SESSIONS_KEY = (userId: string) => `bureau:user:${userId}:sessions`;

/**
 * Return true when the user has ANY live Bureau session whose status field
 * is `'dnd'`. Returns false when the user has no live sessions at all
 * (they are not on Bureau right now, so they cannot be in DND — the
 * visitor's knock will just sit in the inbox until the owner next logs in).
 */
export async function isUserInDnd(
  redis: Redis,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;

  const sessionIds = await redis.smembers(USER_SESSIONS_KEY(userId));
  if (sessionIds.length === 0) return false;

  const pipeline = redis.pipeline();
  for (const sessionId of sessionIds) {
    pipeline.hget(SESSION_KEY(sessionId), 'status');
  }
  const results = await pipeline.exec();
  if (!results) return false;

  for (const entry of results) {
    if (!entry) continue;
    const [err, value] = entry;
    if (err) continue;
    if (typeof value === 'string' && value === 'dnd') {
      return true;
    }
  }
  return false;
}
