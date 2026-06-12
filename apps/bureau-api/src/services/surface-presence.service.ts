/**
 * Bureau surface-presence check (Agent D, presence-and-immediate-interaction).
 *
 * imported by apps/bureau-api/src/routes/livekit.routes.ts in the POST
 * /v1/surface-huddle/token handler.
 *
 * Semantic note (v2 unified-call model — Phase 3): "on the surface" is
 * exactly equivalent to "in the canonical LiveKit room for the surface,"
 * which is `huddle-{surface_app}-{surface_id}`. The bureau-client SDK joins
 * that room automatically the moment describeLocation() reports a matching
 * `surface_id`, so the presence row maintained by ws.routes.ts is the
 * source of truth for both "is this user on the surface" and "is this user
 * already in the surface's call." A token mint for someone NOT on the
 * surface would be minting access to a room they aren't supposed to be in.
 *
 * Symmetric authorization for surface huddle tokens: when a recipient
 * accepts a ring on, say, a Brief doc and asks bureau-api to mint a
 * LiveKit token for the huddle room scoped to that surface, we want to
 * verify the caller is ACTUALLY on the surface they claim before handing
 * over a token. Without this check a malicious agent that guesses (or
 * leaks) any `surface_app` + `surface_id` pair could mint a token for
 * the corresponding huddle room and listen in.
 *
 * "On the surface" means: at least one of the user's live Bureau
 * presence sessions (`bureau:sess:*`, scoped to `bureau:user:{userId}:sessions`)
 * has both:
 *   - `locationApp` exactly equal to the requested `surfaceApp`, AND
 *   - `locationUrl` containing the requested `surfaceId` as a substring.
 *
 * The substring match on `surfaceId` is intentional for v1: the SDK
 * convention is `/<app>/<resource>/<id>` (sometimes with trailing
 * query/hash) and the routing layer can interpose extra segments
 * (`/b3/tasks/<id>`, `/brief/d/<id>`, `/board/c/<id>`, etc.). A
 * substring check is sufficient because `surfaceId` is always a UUID-ish
 * identifier with high entropy — accidental collisions across surfaces
 * are vanishingly unlikely. Tightening this to a strict path-segment
 * match is a v2 hardening item once we settle the surface URL shape per
 * app (see docs/plans/presence-and-immediate-interaction.md).
 *
 * The session must also belong to the same `orgId` as the caller — a
 * surface_id collision across tenants is unlikely but the check is
 * cheap and guarantees the symmetric-auth property holds across orgs.
 *
 * Stale sessions (TTL lapsed but not yet reaped) HGETALL to an empty
 * record and are simply skipped — fail-closed: if we can't verify the
 * user is on the surface, they don't get a token.
 */

import type Redis from 'ioredis';
import { URL_SURFACE_APP, deriveUrlSurfaceId } from '@bigbluebam/shared';

const SESSION_KEY = (sessionId: string) => `bureau:sess:${sessionId}`;
const USER_SESSIONS_KEY = (userId: string) => `bureau:user:${userId}:sessions`;

/**
 * Return true when `userId` has at least one live Bureau session in
 * `orgId` whose `locationApp` exactly matches `surfaceApp` and whose
 * `locationUrl` contains `surfaceId` as a substring.
 *
 * Empty / missing inputs fail closed (return false) so the caller can
 * use a single `if (!ok) return 403` guard without separate validation.
 */
export async function isUserOnSurface(
  redis: Redis,
  userId: string,
  orgId: string,
  surfaceApp: string,
  surfaceId: string,
): Promise<boolean> {
  if (!userId || !orgId || !surfaceApp || !surfaceId) return false;

  const sessionIds = await redis.smembers(USER_SESSIONS_KEY(userId));
  if (sessionIds.length === 0) return false;

  const pipeline = redis.pipeline();
  for (const sessionId of sessionIds) {
    pipeline.hmget(
      SESSION_KEY(sessionId),
      'orgId',
      'locationApp',
      'locationUrl',
    );
  }
  const results = await pipeline.exec();
  if (!results) return false;

  for (const entry of results) {
    if (!entry) continue;
    const [err, value] = entry;
    if (err) continue;
    if (!Array.isArray(value)) continue;
    const [sessOrgId, sessApp, sessUrl] = value as Array<string | null>;
    if (!sessOrgId || sessOrgId !== orgId) continue;
    if (!sessUrl || sessUrl.length === 0) continue;
    if (surfaceApp === URL_SURFACE_APP) {
      // URL-derived surface ("every place is a room"): the synthetic id
      // is a hash of the normalized path, so a substring check can never
      // match. Re-derive from the session's reported URL with the SAME
      // shared function the client used — byte-for-byte agreement is the
      // whole contract (see @bigbluebam/shared bureau-surface.ts). The
      // locationApp is intentionally NOT compared here: the path inside
      // the URL already disambiguates apps, and the pseudo-app 'url' has
      // no session counterpart.
      if (deriveUrlSurfaceId(sessUrl) === surfaceId) return true;
      continue;
    }
    if (!sessApp || sessApp !== surfaceApp) continue;
    if (sessUrl.includes(surfaceId)) return true;
  }

  return false;
}

/**
 * `isUserOnSurface` with a short bounded grace window.
 *
 * Why the grace exists: the bureau-client SDK fires the surface-huddle
 * token mint (a REST POST) the instant the location changes, while the
 * `location_update` that establishes the presence session travels over a
 * SEPARATE WebSocket connection — which may still be (re)connecting when
 * the mint lands. A strict single-shot check would therefore intermittently
 * 403 a legitimate auto-join purely on timing. We re-check a few times over
 * ~0.6s so the WS path can win the race; a genuine cross-org probe (no live
 * session on the surface at all) still fails after every attempt.
 *
 * The window is deliberately small: it only delays the (rare) racing legit
 * mint, never a happy-path one (the first check returns immediately when the
 * session is already present), and the client retries once more on a 403 so
 * a slow WS handshake beyond this window still recovers.
 */
export async function isUserOnSurfaceWithGrace(
  redis: Redis,
  userId: string,
  orgId: string,
  surfaceApp: string,
  surfaceId: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const delayMs = Math.max(0, opts.delayMs ?? 200);
  for (let i = 0; i < attempts; i++) {
    if (await isUserOnSurface(redis, userId, orgId, surfaceApp, surfaceId)) {
      return true;
    }
    if (i < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
