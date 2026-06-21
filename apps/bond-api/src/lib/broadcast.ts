/**
 * Redis PubSub broadcast for Bond realtime events. Channel naming follows
 * the suite convention used by blueprint-api: `bond:<pipelineId>` carries
 * every deal mutation on a single pipeline. The bond-api WebSocket hub
 * (routes/ws.routes.ts) subscribes and fans out to connected clients in
 * the pipeline room so a second viewer sees deals move live (T1).
 *
 * Fire-and-forget: a Redis failure must never block the caller's mutation.
 * This carries no payload the client trusts — every event simply tells the
 * pipeline board "something changed, refetch" (see use-pipeline-sync.ts).
 */
import type Redis from 'ioredis';

export type DealEvent =
  | { type: 'bond.deal.created'; pipeline_id: string; deal_id: string }
  | { type: 'bond.deal.updated'; pipeline_id: string; deal_id: string }
  | { type: 'bond.deal.stage_moved'; pipeline_id: string; deal_id: string; stage_id: string }
  | { type: 'bond.deal.deleted'; pipeline_id: string; deal_id: string }
  | { type: 'bond.deal.restored'; pipeline_id: string; deal_id: string }
  | { type: 'bond.deal.closed'; pipeline_id: string; deal_id: string; outcome: 'won' | 'lost' }
  | { type: 'bond.deal.duplicated'; pipeline_id: string; deal_id: string };

export async function broadcastToPipeline(
  redis: Redis,
  pipelineId: string,
  event: DealEvent,
): Promise<void> {
  if (!pipelineId) return;
  try {
    await redis.publish(`bond:${pipelineId}`, JSON.stringify(event));
  } catch {
    // Suppress — never let realtime fanout block a successful mutation.
  }
}
