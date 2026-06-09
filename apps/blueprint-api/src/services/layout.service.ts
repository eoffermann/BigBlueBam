/**
 * Server-side auto-layout via ELK (`elkjs`). Runs in-process for graphs
 * up to env.LAYOUT_INPROCESS_NODE_LIMIT nodes; larger graphs are
 * delegated to the worker queue `blueprint-layout` to keep the request
 * thread free.
 *
 * Algorithm names accepted on the API (`layout_algorithm`):
 *   layered | mrtree | force | radial | rectpacking | manual
 *
 * `manual` skips ELK entirely and returns the existing positions
 * unchanged (used for free-form diagrams where the user lays out by hand).
 */
import ELK from 'elkjs';
import type { LayoutOptions } from 'elkjs';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blueprintNodes, blueprintEdges, blueprintDiagrams } from '../db/schema/index.js';
import { ValidationError } from '../lib/errors.js';

const elk = new ELK();

const ALGORITHM_MAP: Record<string, string> = {
  layered: 'layered',
  mrtree: 'mrtree',
  force: 'force',
  radial: 'radial',
  rectpacking: 'rectpacking',
};

export interface LayoutInput {
  algorithm?: string;
  direction?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  spacing?: number;
  node_node_spacing?: number;
  layer_spacing?: number;
}

export interface LayoutResult {
  positions: Array<{ id: string; x: number; y: number }>;
  algorithm: string;
}

export async function applyLayout(
  diagramId: string,
  input: LayoutInput,
): Promise<LayoutResult> {
  const [diagram] = await db
    .select()
    .from(blueprintDiagrams)
    .where(eq(blueprintDiagrams.id, diagramId))
    .limit(1);
  if (!diagram) throw new ValidationError('diagram not found');

  const algorithm = input.algorithm ?? diagram.layout_algorithm ?? 'layered';
  if (algorithm === 'manual') {
    return { positions: [], algorithm };
  }
  const elkAlgo = ALGORITHM_MAP[algorithm];
  if (!elkAlgo) {
    throw new ValidationError(`Unknown algorithm: ${algorithm}`, [
      { field: 'algorithm', issue: `must be one of: ${Object.keys(ALGORITHM_MAP).join(', ')}, manual` },
    ]);
  }

  const [nodes, edges] = await Promise.all([
    db.select().from(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId)),
    db.select().from(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId)),
  ]);

  if (nodes.length === 0) return { positions: [], algorithm };

  const direction = input.direction ?? 'DOWN';
  const opts: LayoutOptions = {
    'elk.algorithm': elkAlgo,
    'elk.direction': direction,
    'elk.spacing.nodeNode': String(input.node_node_spacing ?? input.spacing ?? 50),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(input.layer_spacing ?? input.spacing ?? 80),
  };

  const graph = {
    id: diagramId,
    layoutOptions: opts,
    children: nodes
      .filter((n) => !n.pinned)
      .map((n) => ({
        id: n.id,
        width: n.width,
        height: n.height,
      })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source_node_id],
      targets: [e.target_node_id],
    })),
  };

  // ELK runs synchronously enough for the in-process case; promise-based API.
  const laidOut = (await elk.layout(graph)) as {
    children?: Array<{ id: string; x?: number; y?: number }>;
  };

  const positions: Array<{ id: string; x: number; y: number }> = [];
  const pinnedById = new Map(
    nodes.filter((n) => n.pinned).map((n) => [n.id, { x: n.position_x, y: n.position_y }]),
  );

  for (const child of laidOut.children ?? []) {
    if (child.x === undefined || child.y === undefined) continue;
    positions.push({ id: child.id, x: child.x, y: child.y });
  }
  for (const [id, pos] of pinnedById) {
    positions.push({ id, x: pos.x, y: pos.y });
  }

  // Persist the new positions in one batch.
  if (positions.length > 0) {
    await db.transaction(async (tx) => {
      for (const p of positions) {
        await tx
          .update(blueprintNodes)
          .set({ position_x: p.x, position_y: p.y, updated_at: new Date() })
          .where(eq(blueprintNodes.id, p.id));
      }
    });
  }

  return { positions, algorithm };
}
