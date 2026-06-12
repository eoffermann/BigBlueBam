/**
 * Bureau ring signaling (presence-and-immediate-interaction).
 *
 * "Ringing" a user is the immediate-interaction primitive: anyone who shares
 * a content surface with a recipient can ask the bureau-client SDK to pop a
 * full-screen incoming-call overlay on the recipient's screen. The SDK on
 * the recipient end already subscribes to the `user:{userId}` Redis PubSub
 * channel (see apps/bureau-api/src/routes/ws.routes.ts ↦ personalChannel);
 * a 'ring_incoming' message type joins the existing knock_incoming / summon
 * envelope set.
 *
 * SEMANTIC SHIFT (v2 unified-call model — Phase 3).
 *
 *   Ring is a NOTIFICATION, not a call-creation primitive. The LiveKit room
 *   for the surface (`huddle-{surface_app}-{surface_id}`) always exists and
 *   the recipient's bureau-client SDK joins it automatically on navigation
 *   to the surface URL via the ActiveCallManager (see
 *   packages/bureau-client/src/active-room.ts). Ringing is the polite "hey,
 *   come look at this with me" that draws the recipient to a room they
 *   could already be in — not a request to create a call.
 *
 * The ring is a one-shot push:
 *   - The recipient sees the overlay and chooses accept / decline / mute.
 *   - On accept, the SDK navigates to the surface URL; the unified-call
 *     manager joins LiveKit room `huddle-{app}-{id}` automatically. The
 *     explicit token POST on accept is now redundant — navigation is
 *     sufficient.
 *   - There is no `bureau_rings` table; if the recipient misses the ring
 *     (offline, browser closed) the in-flight signal is dropped, just like
 *     a phone ringing into a dead line. A follow-up "leave a note" path can
 *     use Banter DMs (same pattern as knocks §4.3). The only server-side
 *     state is a short-lived Redis record keyed by ring_token (see
 *     `takeRingRecord`) so the WS hub can validate + route the recipient's
 *     `ring_respond` back to the caller as `ring_responded`.
 *
 * `ring_token` is a short opaque id so the recipient's UI can correlate the
 * incoming ring with its eventual accept/decline reply. `expires_at` lets
 * the recipient SDK auto-dismiss the overlay after ~30s.
 *
 * Wire note: the outbound frame type is `ring_incoming` — this MUST match
 * the bureau-client SDK's subscription in
 * packages/bureau-client/src/ring-handler.tsx (`client.on('ring_incoming')`)
 * and the RingIncomingEvent type in packages/bureau-client/src/types.ts.
 * (It originally shipped as `'ring'`, which the SDK never listened for —
 * rings silently vanished. Bureau troubleshooting pass, 2026-06-10.)
 */

import type Redis from 'ioredis';
import { nanoid } from 'nanoid';

/** Default time the incoming-call overlay should stay live before auto-dismiss. */
const RING_TTL_MS = 30_000;

/**
 * How long the server-side ring record survives in Redis. Slightly longer
 * than the overlay TTL so a respond that races the expiry still resolves.
 */
const RING_RECORD_TTL_SECONDS = 90;

const ringRecordKey = (ringToken: string) => `bureau:ring:${ringToken}`;

export interface RingPayload {
  type: 'ring_incoming';
  from_user_id: string;
  from_user_name: string;
  surface_app: string;
  surface_id: string;
  surface_label: string | null;
  /** Concrete destination URL. Required for 'url'-kind surfaces (the
   *  recipient cannot reconstruct a URL from the hashed surface id);
   *  optional enrichment for entity surfaces. */
  surface_url: string | null;
  ring_token: string;
  expires_at: string;
}

/** Server-side record for an in-flight ring, keyed by ring_token. */
export interface RingRecord {
  fromUserId: string;
  toUserId: string;
  orgId: string;
  surfaceApp: string;
  surfaceId: string;
}

export interface RingResult {
  ring_token: string;
  expires_at: string;
  delivered: number;
}

/**
 * Publish a ring event to the recipient's `user:{toUserId}` channel.
 *
 * The publish runs through the same {type,data,timestamp} envelope used by
 * the other bureau frames (see ws.routes.ts ↦ frame()) so the recipient
 * SDK's existing pubsub forwarder can pass it straight through to its
 * onMessage handler.
 *
 * Returns the ring_token (so the caller can correlate any future accept /
 * decline event on the same recipient channel) and how many subscribers
 * received the publish — `delivered === 0` means the recipient is offline.
 */
export async function ringUser(
  redis: Redis,
  fromUserId: string,
  fromUserName: string,
  toUserId: string,
  orgId: string,
  surfaceApp: string,
  surfaceId: string,
  surfaceLabel: string | null,
  surfaceUrl: string | null = null,
): Promise<RingResult> {
  const ringToken = nanoid(16);
  const expiresAt = new Date(Date.now() + RING_TTL_MS).toISOString();

  const payload: RingPayload = {
    type: 'ring_incoming',
    from_user_id: fromUserId,
    from_user_name: fromUserName,
    surface_app: surfaceApp,
    surface_id: surfaceId,
    surface_label: surfaceLabel,
    surface_url: surfaceUrl,
    ring_token: ringToken,
    expires_at: expiresAt,
  };

  // Persist the short-lived record FIRST so a fast respond can't race the
  // write. Best-effort: a Redis hiccup here only disables ring_responded
  // routing for this ring, not the ring itself.
  const record: RingRecord = {
    fromUserId,
    toUserId,
    orgId,
    surfaceApp,
    surfaceId,
  };
  try {
    await redis.set(
      ringRecordKey(ringToken),
      JSON.stringify(record),
      'EX',
      RING_RECORD_TTL_SECONDS,
    );
  } catch {
    /* best-effort — see comment above */
  }

  // Wrap in the standard {type,data,timestamp} envelope so it threads
  // through the existing ws.routes.ts subscriber.on('message', ...) path
  // unchanged. The bureau-client SDK branches on type === 'ring_incoming'
  // and renders the incoming-call overlay.
  const envelope = JSON.stringify({
    type: 'ring_incoming',
    data: payload,
    timestamp: new Date().toISOString(),
  });

  const delivered = await redis.publish(`user:${toUserId}`, envelope);

  return { ring_token: ringToken, expires_at: expiresAt, delivered };
}

/**
 * Force-invite (admin/owner/SuperUser; gate enforced in ring.routes.ts).
 *
 * Instead of the accept-or-decline ring overlay, the recipient gets the
 * existing SUMMON toast with autoFollow — a 3-second cancellable
 * countdown, then their SDK navigates to the destination. Forced, but
 * never a silent teleport: the recipient always sees who pulled them
 * and can hit "Stay" inside the window.
 *
 * Reuses the summon_incoming frame the SDK already obeys (see
 * packages/bureau-client/src/summon-handler.tsx); no new client wiring
 * is needed on the recipient side. The synthetic summonId carries a
 * `force-` prefix purely for log greppability.
 */
export async function forceNavigateUser(
  redis: Redis,
  fromUserId: string,
  fromUserName: string,
  toUserId: string,
  targetUrl: string,
  label: string | null,
): Promise<RingResult> {
  const summonId = `force-${nanoid(12)}`;
  const expiresAt = new Date(Date.now() + RING_TTL_MS).toISOString();

  const envelope = JSON.stringify({
    type: 'summon_incoming',
    data: {
      type: 'summon_incoming',
      summonId,
      summoner: { id: fromUserId, name: fromUserName },
      targetUrl,
      app: 'url',
      label,
      lkRoomHint: null,
      autoFollow: true,
    },
    timestamp: new Date().toISOString(),
  });

  const delivered = await redis.publish(`user:${toUserId}`, envelope);
  return { ring_token: summonId, expires_at: expiresAt, delivered };
}

/**
 * Atomically read-and-delete the ring record for a token. Returns null when
 * the token is unknown or already consumed (expired, double-respond from a
 * second device, or a forged token). The delete makes respond one-shot: the
 * first device to answer wins, later responds are silently ignored.
 */
export async function takeRingRecord(
  redis: Redis,
  ringToken: string,
): Promise<RingRecord | null> {
  if (!ringToken) return null;
  const key = ringRecordKey(ringToken);
  const raw = await redis.get(key);
  if (!raw) return null;
  // Delete before parse — even a corrupt record is consumed exactly once.
  await redis.del(key);
  try {
    const parsed = JSON.parse(raw) as Partial<RingRecord>;
    if (
      typeof parsed.fromUserId !== 'string' ||
      typeof parsed.toUserId !== 'string' ||
      typeof parsed.orgId !== 'string'
    ) {
      return null;
    }
    return {
      fromUserId: parsed.fromUserId,
      toUserId: parsed.toUserId,
      orgId: parsed.orgId,
      surfaceApp: typeof parsed.surfaceApp === 'string' ? parsed.surfaceApp : '',
      surfaceId: typeof parsed.surfaceId === 'string' ? parsed.surfaceId : '',
    };
  } catch {
    return null;
  }
}
