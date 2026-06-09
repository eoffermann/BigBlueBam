import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blueprintEdges, blueprintNodes } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export type EdgeRow = typeof blueprintEdges.$inferSelect;

export async function listEdges(diagramId: string) {
  return await db.select().from(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId));
}

export interface CreateEdgeInput {
  source_node_id: string;
  target_node_id: string;
  source_handle?: string | null;
  target_handle?: string | null;
  kind?: string;
  label?: string | null;
  marker_start?: string;
  marker_end?: string;
  style?: Record<string, unknown>;
  waypoints?: Array<{ x: number; y: number }>;
}

export async function createEdge(diagramId: string, input: CreateEdgeInput): Promise<EdgeRow> {
  if (input.source_node_id === input.target_node_id) {
    throw new ValidationError('source_node_id and target_node_id must be different', [
      { field: 'target_node_id', issue: 'must differ from source_node_id' },
    ]);
  }
  // Confirm both endpoints belong to this diagram so a client can't link
  // across diagrams via a crafted UUID pair.
  const nodes = await db
    .select({ id: blueprintNodes.id })
    .from(blueprintNodes)
    .where(eq(blueprintNodes.diagram_id, diagramId));
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(input.source_node_id) || !ids.has(input.target_node_id)) {
    throw new ValidationError('source and target must be nodes of this diagram', [
      { field: 'source_node_id', issue: 'not in this diagram' },
    ]);
  }
  const [row] = await db
    .insert(blueprintEdges)
    .values({
      diagram_id: diagramId,
      source_node_id: input.source_node_id,
      target_node_id: input.target_node_id,
      source_handle: input.source_handle ?? null,
      target_handle: input.target_handle ?? null,
      kind: input.kind ?? 'default',
      label: input.label ?? null,
      marker_start: input.marker_start ?? 'none',
      marker_end: input.marker_end ?? 'arrowclosed',
      style: (input.style ?? {}) as Record<string, unknown>,
      waypoints: input.waypoints ? (input.waypoints as unknown as Record<string, unknown>) : null,
    })
    .returning();
  return row!;
}

export interface UpdateEdgeInput {
  source_handle?: string | null;
  target_handle?: string | null;
  kind?: string;
  label?: string | null;
  marker_start?: string;
  marker_end?: string;
  style?: Record<string, unknown>;
  waypoints?: Array<{ x: number; y: number }> | null;
}

export async function updateEdge(
  diagramId: string,
  edgeId: string,
  patch: UpdateEdgeInput,
): Promise<EdgeRow> {
  const update: Record<string, unknown> = { updated_at: new Date() };
  for (const key of Object.keys(patch) as Array<keyof UpdateEdgeInput>) {
    if (patch[key] !== undefined) update[key] = patch[key];
  }
  const [row] = await db
    .update(blueprintEdges)
    .set(update)
    .where(and(eq(blueprintEdges.id, edgeId), eq(blueprintEdges.diagram_id, diagramId)))
    .returning();
  if (!row) throw new NotFoundError('Edge not found');
  return row;
}

export async function deleteEdge(diagramId: string, edgeId: string) {
  const [row] = await db
    .delete(blueprintEdges)
    .where(and(eq(blueprintEdges.id, edgeId), eq(blueprintEdges.diagram_id, diagramId)))
    .returning({ id: blueprintEdges.id });
  if (!row) throw new NotFoundError('Edge not found');
  return row;
}
