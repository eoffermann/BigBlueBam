/**
 * Bureau ring signaling (presence-and-immediate-interaction).
 *
 * "Ringing" a user is the immediate-interaction primitive: anyone who shares
 * a content surface with a recipient can ask the bureau-client SDK to pop a
 * full-screen incoming-call overlay on the recipient's screen. The SDK on
 * the recipient end already subscribes to the `user:{userId}` Redis PubSub
 * channel (see apps/bureau-api/src/routes/ws.routes.ts ↦ personalChannel);
 * a new 'ring' message type joins the existing knock_incoming / summon
 * envelope set.
 *
 * The ring is a one-shot push:
 *   - The recipient sees the overlay and chooses accept / decline / mute.
 *   - On accept, the SDK mints a surface-huddle token via
 *     POST /v1/surface-huddle/token and joins the same room name.
 *   - Nothing is persisted server-side except the audit row recorded by
 *     the calling route. There is no `bureau_rings` table; if the recipient
 *     misses the ring (offline, browser closed) the in-flight signal is
 *     dropped, just like a phone ringing into a dead line. A follow-up
 *     "leave a note" path can use Banter DMs (same pattern as knocks §4.3).
 *
 * `ring_token` is a short opaque id so the recipient's UI can correlate the
 * incoming ring with its eventual accept/decline reply. `expires_at` lets
 * the recipient SDK auto-dismiss the overlay after ~30s.
 */

import type Redis from 'ioredis';
import { nanoid } from 'nanoid';

/** Default time the incoming-call overlay should stay live before auto-dismiss. */
const RING_TTL_MS = 30_000;

export interface RingPayload {
  type: 'ring';
  from_user_id: string;
  from_user_name: string;
  surface_app: string;
  surface_id: string;
  surface_label: string | null;
  ring_token: string;
  expires_at: string;
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
  surfaceApp: string,
  surfaceId: string,
  surfaceLabel: string | null,
): Promise<RingResult> {
  const ringToken = nanoid(16);
  const expiresAt = new Date(Date.now() + RING_TTL_MS).toISOString();

  const payload: RingPayload = {
    type: 'ring',
    from_user_id: fromUserId,
    from_user_name: fromUserName,
    surface_app: surfaceApp,
    surface_id: surfaceId,
    surface_label: surfaceLabel,
    ring_token: ringToken,
    expires_at: expiresAt,
  };

  // Wrap in the standard {type,data,timestamp} envelope so it threads
  // through the existing ws.routes.ts subscriber.on('message', ...) path
  // unchanged. The bureau-client SDK is responsible for branching on
  // type === 'ring' and rendering the incoming-call overlay.
  const envelope = JSON.stringify({
    type: 'ring',
    data: payload,
    timestamp: new Date().toISOString(),
  });

  const delivered = await redis.publish(`user:${toUserId}`, envelope);

  return { ring_token: ringToken, expires_at: expiresAt, delivered };
}
