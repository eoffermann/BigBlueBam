/**
 * Diagram export. MVP supports two formats:
 *  - 'json'    — the full graph payload (diagram + nodes + edges)
 *  - 'mermaid' — a Mermaid-syntax string keyed off the diagram_type.
 *                Flowcharts and decision trees → flowchart TD/LR;
 *                org charts → flowchart TD;
 *                mindmaps   → mindmap;
 *                everything else → flowchart LR as a sane default.
 *
 * SVG/PNG are deferred to a worker job (`blueprint-export`) because they
 * require a headless renderer; the route returns 202 + a job id for those.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blueprintDiagrams, blueprintNodes, blueprintEdges } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export type ExportFormat = 'json' | 'mermaid' | 'svg' | 'png';

export async function exportDiagram(
  diagramId: string,
  format: ExportFormat,
): Promise<{ format: ExportFormat; content_type: string; body: string }> {
  const [diagram] = await db
    .select()
    .from(blueprintDiagrams)
    .where(eq(blueprintDiagrams.id, diagramId))
    .limit(1);
  if (!diagram) throw new NotFoundError('Diagram not found');
  const nodes = await db.select().from(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId));
  const edges = await db.select().from(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId));

  if (format === 'json') {
    return {
      format,
      content_type: 'application/json',
      body: JSON.stringify({ diagram, nodes, edges }, null, 2),
    };
  }

  if (format === 'mermaid') {
    return {
      format,
      content_type: 'text/plain; charset=utf-8',
      body: toMermaid(diagram.diagram_type, nodes, edges),
    };
  }

  throw new ValidationError(`Format '${format}' is not supported in-process. SVG/PNG are deferred to the worker queue.`);
}

function escapeMermaid(label: string): string {
  // Mermaid labels are wrapped in quotes; escape internal quotes.
  return label.replace(/"/g, '\\"');
}

function nodeRefForMermaid(id: string): string {
  // Mermaid node ids can't contain hyphens. UUID hyphens → underscores.
  return 'n' + id.replace(/-/g, '_');
}

export function toMermaid(
  diagramType: string,
  nodes: Array<typeof blueprintNodes.$inferSelect>,
  edges: Array<typeof blueprintEdges.$inferSelect>,
): string {
  if (diagramType === 'mindmap') {
    // Mermaid mindmap requires a single root. Pick the node with no incoming
    // edges, or the first node, as the root.
    const incoming = new Set(edges.map((e) => e.target_node_id));
    const root = nodes.find((n) => !incoming.has(n.id)) ?? nodes[0];
    if (!root) return 'mindmap\n  root((empty))';
    const lines = ['mindmap'];
    const visited = new Set<string>();
    const visit = (n: typeof blueprintNodes.$inferSelect, depth: number) => {
      if (visited.has(n.id)) return;
      visited.add(n.id);
      lines.push('  '.repeat(depth + 1) + escapeMermaid(n.label || '(unnamed)'));
      for (const edge of edges.filter((e) => e.source_node_id === n.id)) {
        const child = nodes.find((m) => m.id === edge.target_node_id);
        if (child) visit(child, depth + 1);
      }
    };
    visit(root, 0);
    return lines.join('\n');
  }
  const orient =
    diagramType === 'org_chart' || diagramType === 'flowchart' || diagramType === 'decision_tree'
      ? 'TD'
      : 'LR';
  const lines = [`flowchart ${orient}`];
  for (const n of nodes) {
    const label = escapeMermaid(n.label || '(unnamed)');
    const id = nodeRefForMermaid(n.id);
    const open = n.shape === 'diamond' ? '{' : n.shape === 'ellipse' ? '(' : '[';
    const close = n.shape === 'diamond' ? '}' : n.shape === 'ellipse' ? ')' : ']';
    lines.push(`  ${id}${open}"${label}"${close}`);
  }
  for (const e of edges) {
    const sId = nodeRefForMermaid(e.source_node_id);
    const tId = nodeRefForMermaid(e.target_node_id);
    const arrow = e.label ? `-- ${escapeMermaid(e.label)} -->` : '-->';
    lines.push(`  ${sId} ${arrow} ${tId}`);
  }
  return lines.join('\n');
}
