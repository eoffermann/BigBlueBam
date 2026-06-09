/**
 * Diagram import. MVP supports Mermaid flowcharts only — the most common
 * form by far. DOT/Graphviz is deferred to a follow-up.
 *
 * The parser is intentionally permissive: it understands the subset that
 * the export side generates plus the typical Mermaid `flowchart TD` /
 * `graph LR` shape: node declarations of the form `A[Label]`, `A(Label)`,
 * `A{Label}`, and edges of the form `A --> B`, `A -- label --> B`,
 * `A --|label| B`, `A -.-> B`. It is NOT a general Mermaid parser; weird
 * input degrades to "best effort" — unknown lines are ignored.
 */
import { db } from '../db/index.js';
import { blueprintNodes, blueprintEdges } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

interface ParsedNode {
  ref: string; // the Mermaid id (e.g. 'A')
  label: string;
  shape: 'rectangle' | 'rounded' | 'diamond' | 'ellipse';
}

interface ParsedEdge {
  source: string;
  target: string;
  label?: string;
}

interface ParsedGraph {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
}

const NODE_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[("?)([^\]"]+)\2\]|\(("?)([^)"]+)\4\)|\{("?)([^}"]+)\6\})/;
const EDGE_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:-\.->|-->|--)\s*(?:\|([^|]+)\|\s*)?(?:--\s*([^->]+?)\s*-->\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/;

export function parseMermaid(source: string): ParsedGraph {
  const lines = source.split(/\r?\n/);
  const nodes = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith('%%') ||
      line.startsWith('flowchart') ||
      line.startsWith('graph') ||
      line.startsWith('mindmap')
    ) {
      continue;
    }
    const nodeMatch = NODE_RE.exec(line);
    if (nodeMatch) {
      const ref = nodeMatch[1]!;
      const label = nodeMatch[3] ?? nodeMatch[5] ?? nodeMatch[7] ?? ref;
      let shape: ParsedNode['shape'] = 'rectangle';
      if (nodeMatch[5]) shape = 'ellipse';
      else if (nodeMatch[7]) shape = 'diamond';
      if (!nodes.has(ref)) nodes.set(ref, { ref, label, shape });
      else nodes.get(ref)!.label = label;
      // A line with a node decl might continue with an edge — fall through.
    }
    const edgeMatch = EDGE_RE.exec(line);
    if (edgeMatch) {
      const source = edgeMatch[1]!;
      const target = edgeMatch[4]!;
      const label = edgeMatch[2] ?? edgeMatch[3];
      if (!nodes.has(source)) nodes.set(source, { ref: source, label: source, shape: 'rectangle' });
      if (!nodes.has(target)) nodes.set(target, { ref: target, label: target, shape: 'rectangle' });
      edges.push({ source, target, label });
    }
  }
  return { nodes: Array.from(nodes.values()), edges };
}

export async function importMermaid(
  diagramId: string,
  source: string,
  options: { replace?: boolean } = {},
): Promise<{ created_nodes: number; created_edges: number }> {
  const parsed = parseMermaid(source);

  if (options.replace) {
    await db.transaction(async (tx) => {
      await tx.delete(blueprintEdges).where(eq(blueprintEdges.diagram_id, diagramId));
      await tx.delete(blueprintNodes).where(eq(blueprintNodes.diagram_id, diagramId));
    });
  }

  // Insert nodes, capture ref → uuid mapping.
  const refToUuid = new Map<string, string>();
  if (parsed.nodes.length > 0) {
    const rows = await db
      .insert(blueprintNodes)
      .values(
        parsed.nodes.map((n) => ({
          diagram_id: diagramId,
          label: n.label,
          shape: n.shape,
        })),
      )
      .returning({ id: blueprintNodes.id, label: blueprintNodes.label });
    // We can't trivially round-trip ref → row, so we re-pair by index since
    // Postgres returns rows in insert order with postgres-js.
    for (let i = 0; i < parsed.nodes.length; i++) {
      const r = rows[i];
      if (r) refToUuid.set(parsed.nodes[i]!.ref, r.id);
    }
  }

  const edgeRows = parsed.edges
    .filter((e) => refToUuid.has(e.source) && refToUuid.has(e.target))
    .map((e) => ({
      diagram_id: diagramId,
      source_node_id: refToUuid.get(e.source)!,
      target_node_id: refToUuid.get(e.target)!,
      label: e.label ?? null,
    }));
  if (edgeRows.length > 0) {
    await db.insert(blueprintEdges).values(edgeRows);
  }

  return { created_nodes: parsed.nodes.length, created_edges: edgeRows.length };
}
