import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blueprintNodes, blueprintEdges } from '../db/schema/index.js';
import { NotFoundError } from '../lib/errors.js';

export type NodeRow = typeof blueprintNodes.$inferSelect;

export async function listNodes(diagramId: string) {
  return await db.select().from(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId));
}

export interface CreateNodeInput {
  shape?: string;
  label?: string;
  description?: string;
  parent_node_id?: string | null;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
  z_index?: number;
  pinned?: boolean;
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
  ref_entity_type?: string | null;
  ref_entity_id?: string | null;
}

export async function createNode(diagramId: string, input: CreateNodeInput): Promise<NodeRow> {
  const [row] = await db
    .insert(blueprintNodes)
    .values({
      diagram_id: diagramId,
      parent_node_id: input.parent_node_id ?? null,
      shape: input.shape ?? 'rounded',
      label: input.label ?? '',
      description: input.description ?? null,
      position_x: input.position_x ?? 0,
      position_y: input.position_y ?? 0,
      width: input.width ?? 160,
      height: input.height ?? 56,
      z_index: input.z_index ?? 0,
      pinned: input.pinned ?? false,
      style: (input.style ?? {}) as Record<string, unknown>,
      data: (input.data ?? {}) as Record<string, unknown>,
      ref_entity_type: input.ref_entity_type ?? null,
      ref_entity_id: input.ref_entity_id ?? null,
    })
    .returning();
  return row!;
}

export interface UpdateNodeInput {
  shape?: string;
  label?: string;
  description?: string | null;
  parent_node_id?: string | null;
  width?: number;
  height?: number;
  z_index?: number;
  pinned?: boolean;
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
  ref_entity_type?: string | null;
  ref_entity_id?: string | null;
}

export async function updateNode(
  diagramId: string,
  nodeId: string,
  patch: UpdateNodeInput,
): Promise<NodeRow> {
  const update: Record<string, unknown> = { updated_at: new Date() };
  for (const key of Object.keys(patch) as Array<keyof UpdateNodeInput>) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  const [row] = await db
    .update(blueprintNodes)
    .set(update)
    .where(and(eq(blueprintNodes.id, nodeId), eq(blueprintNodes.diagram_id, diagramId)))
    .returning();
  if (!row) throw new NotFoundError('Node not found');
  return row;
}

export async function moveNode(
  diagramId: string,
  nodeId: string,
  positionX: number,
  positionY: number,
  pinned?: boolean,
): Promise<NodeRow> {
  const update: Record<string, unknown> = {
    position_x: positionX,
    position_y: positionY,
    updated_at: new Date(),
  };
  if (pinned !== undefined) update.pinned = pinned;
  const [row] = await db
    .update(blueprintNodes)
    .set(update)
    .where(and(eq(blueprintNodes.id, nodeId), eq(blueprintNodes.diagram_id, diagramId)))
    .returning();
  if (!row) throw new NotFoundError('Node not found');
  return row;
}

export async function deleteNode(diagramId: string, nodeId: string) {
  // Collect cascaded edges first so we can announce them on the realtime channel.
  const cascaded = await db
    .select({ id: blueprintEdges.id })
    .from(blueprintEdges)
    .where(
      and(
        eq(blueprintEdges.diagram_id, diagramId),
        // edges either source or target this node
        // CASCADE on FK handles deletion, we just gather ids
      ),
    );
  const touchingEdges = cascaded
    .map((c) => c.id)
    .filter(Boolean);
  const [row] = await db
    .delete(blueprintNodes)
    .where(and(eq(blueprintNodes.id, nodeId), eq(blueprintNodes.diagram_id, diagramId)))
    .returning({ id: blueprintNodes.id });
  if (!row) throw new NotFoundError('Node not found');
  return { id: row.id, cascaded_edge_ids: touchingEdges };
}
