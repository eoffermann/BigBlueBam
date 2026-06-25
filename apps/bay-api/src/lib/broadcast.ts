/**
 * Redis PubSub broadcast for Bay realtime (mirrors bond-api/src/lib/broadcast.ts).
 * Every annotation/decision mutation publishes a typed event on the channel
 * `bay:version:<versionId>`; the Bay WS hub (routes/ws.routes.ts) subscribes a
 * browser socket to one review version and fans the events out so concurrent
 * reviewers see each other's notes + decisions appear live instead of on next
 * manual refresh.
 *
 * Fire-and-forget: a Redis failure must never block the caller's mutation. The
 * payload carries no trusted data — it just tells the client "something on this
 * version changed, refetch" (see apps/bay/src/hooks/use-bay-realtime.ts).
 */
import type Redis from 'ioredis';

export type BayEvent =
  | { type: 'bay.annotation.created'; version_id: string; annotation_id: string }
  | { type: 'bay.annotation.resolved'; version_id: string; annotation_id: string; resolved: boolean }
  | { type: 'bay.decision.set'; version_id: string };

export function versionChannel(versionId: string): string {
  return `bay:version:${versionId}`;
}

export async function broadcastToVersion(
  redis: Redis,
  versionId: string,
  event: BayEvent,
): Promise<void> {
  if (!versionId) return;
  try {
    await redis.publish(versionChannel(versionId), JSON.stringify(event));
  } catch {
    // Suppress — never let realtime fanout block a successful mutation.
  }
}
