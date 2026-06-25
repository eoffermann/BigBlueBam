/**
 * Redis PubSub broadcast for Bin realtime (mirrors bond-api/src/lib/broadcast.ts).
 * The structured-data editor commits via REST (each commit mints a new immutable
 * version); after a successful commit the route publishes a `bin.data.updated`
 * event on `bin:asset:<assetId>` so other people viewing the same asset refetch
 * instead of seeing stale data. The same channel carries lightweight presence
 * (who else is in the editor). The WS hub (routes/ws.routes.ts) fans both out.
 *
 * Fire-and-forget: a Redis failure must never block a commit. Data events carry
 * no trusted payload — they just say "this asset changed, refetch".
 */
import type Redis from 'ioredis';

export type BinDataEvent = { type: 'bin.data.updated'; asset_id: string };

export function assetChannel(assetId: string): string {
  return `bin:asset:${assetId}`;
}

export function presenceKey(assetId: string): string {
  return `bin:presence:${assetId}`;
}

export async function broadcastToAsset(
  redis: Redis,
  assetId: string,
  event: BinDataEvent,
): Promise<void> {
  if (!assetId) return;
  try {
    await redis.publish(assetChannel(assetId), JSON.stringify(event));
  } catch {
    // Suppress — never let realtime fanout block a successful commit.
  }
}

// Stable per-user color so everyone sees the same person in the same color
// (mirrors blueprint-api awarenessColor).
const PRESENCE_COLORS = [
  '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
];

export function presenceColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}
