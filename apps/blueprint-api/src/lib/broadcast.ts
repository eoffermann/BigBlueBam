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

/* ------------------------------------------------------------------------- *
 * T3 ephemeral awareness (live remote cursors + selection).
 *
 * Awareness rides a SEPARATE Redis channel `blueprint:awareness:<diagramId>`
 * so it never reaches the structural-mutation subscribers (use-diagram-sync),
 * which would otherwise refetch the whole graph on every cursor twitch. These
 * events are never persisted — they vanish on disconnect by design.
 * ------------------------------------------------------------------------- */

export type AwarenessEvent =
  | {
      type: 'blueprint.awareness.cursor';
      diagram_id: string;
      user_id: string;
      name: string;
      color: string;
      x: number;
      y: number;
    }
  | {
      type: 'blueprint.awareness.selection';
      diagram_id: string;
      user_id: string;
      name: string;
      color: string;
      node_ids: string[];
      edge_ids: string[];
    }
  | { type: 'blueprint.awareness.left'; diagram_id: string; user_id: string };

export function awarenessChannel(diagramId: string): string {
  return `blueprint:awareness:${diagramId}`;
}

// Stable, distinct-ish color per user so every viewer renders the same person
// in the same color without any server-side room state to track or clean up.
const AWARENESS_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

export function awarenessColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return AWARENESS_COLORS[h % AWARENESS_COLORS.length]!;
}

export async function broadcastAwareness(
  redis: Redis,
  diagramId: string,
  event: AwarenessEvent,
): Promise<void> {
  try {
    await redis.publish(awarenessChannel(diagramId), JSON.stringify(event));
  } catch {
    // Suppress — awareness is best-effort and must never throw into a caller.
  }
}
