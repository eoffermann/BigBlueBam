/**
 * Redis PubSub broadcast for blueprint realtime events. Channel naming
 * follows the suite convention: `blueprint:<diagramId>` carries every
 * mutation event on a single diagram. The blueprint-api WebSocket hub
 * (added in a follow-up commit) subscribes and fans out to connected
 * clients in the diagram room.
 *
 * Fire-and-forget: a Redis failure must never block the caller's mutation.
 */
import type Redis from 'ioredis';

export type BlueprintEvent =
  | { type: 'blueprint.node.created'; diagram_id: string; node: unknown }
  | { type: 'blueprint.node.updated'; diagram_id: string; node_id: string; changes: Record<string, unknown>; node?: unknown }
  | { type: 'blueprint.node.moved'; diagram_id: string; node_id: string; position_x: number; position_y: number }
  | { type: 'blueprint.node.deleted'; diagram_id: string; node_id: string; cascaded_edge_ids: string[] }
  | { type: 'blueprint.edge.created'; diagram_id: string; edge: unknown }
  | { type: 'blueprint.edge.updated'; diagram_id: string; edge_id: string; changes: Record<string, unknown>; edge?: unknown }
  | { type: 'blueprint.edge.deleted'; diagram_id: string; edge_id: string }
  | { type: 'blueprint.layout.applied'; diagram_id: string; positions: Array<{ id: string; x: number; y: number }> }
  | { type: 'blueprint.diagram.updated'; diagram_id: string; changes: Record<string, unknown> }
  | { type: 'blueprint.comment.created'; diagram_id: string; comment: unknown };

export async function broadcastToDiagram(
  redis: Redis,
  diagramId: string,
  event: BlueprintEvent,
): Promise<void> {
  try {
    await redis.publish(`blueprint:${diagramId}`, JSON.stringify(event));
  } catch {
    // Suppress — never let realtime fanout block a successful mutation.
  }
}
