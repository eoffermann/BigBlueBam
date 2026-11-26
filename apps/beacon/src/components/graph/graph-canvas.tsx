import { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { runForceLayout, initializePositions, type LayoutNode, type LayoutEdge } from '@/lib/force-layout';
import { edgeColor, edgeDashed } from '@/components/graph/edge-legend';
import { NodePopover } from '@/components/graph/node-popover';
import type { GraphNode, GraphEdge } from '@/hooks/use-graph';
import type { BeaconStatus } from '@/hooks/use-beacons';

// ── Node visual mapping (§5.5.3) ───────────────────────────────────

function nodeRadius(node: GraphNode): number {
  const authority = node.verification_count + node.inbound_link_count;
  // Log scale for better differentiation: min 22, max 60
  if (authority <= 0) return 22;
  return Math.max(22, Math.min(60, 22 + Math.log2(authority + 1) * 8));
}

function nodeRingColor(node: GraphNode): string {
  if (node.status === 'Archived') return '#9ca3af'; // grey
  if (node.status === 'PendingReview') return '#f97316'; // orange

  // Active — check freshness
  if (node.expires_at) {
    const daysUntil = (new Date(node.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntil <= 0) return '#ef4444'; // expired red
    if (daysUntil <= 14) return '#eab308'; // yellow expiring
  }

  if (node.last_verified_at) {
    const daysSince = (Date.now() - new Date(node.last_verified_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) return '#ef4444';
    if (daysSince > 16) return '#eab308';
  }

  return '#22c55e'; // green fresh
}

function isAtRisk(node: GraphNode): boolean {
  if (!node.expires_at) return false;
  const daysUntil = (new Date(node.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysUntil <= 7 && daysUntil > 0;
}

function nodeFillColor(status: BeaconStatus): string {
  switch (status) {
    case 'Active': return '#f0fdf4';
    case 'PendingReview': return '#fff7ed';
    case 'Archived': return '#f4f4f5';
    case 'Retired': return '#fef2f2';
    default: return '#fafafa';
  }
}

function nodeFillColorDark(status: BeaconStatus): string {
  switch (status) {
    case 'Active': return '#052e16';
    case 'PendingReview': return '#431407';
    case 'Archived': return '#27272a';
    case 'Retired': return '#450a0a';
    default: return '#18181b';
  }
}

// ── Types ───────────────────────────────────────────────────────────

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  radius: number;
}

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focalNodeId?: string | null;
  selectedNodeId: string | null;
  showImplicitEdges: boolean;
  filterOverlay?: { status: BeaconStatus[]; tags: string[] };
  onSelectNode: (id: string | null) => void;
  onExpandNode: (id: string, title: string) => void;
  onViewBeacon: (slug: string) => void;
  width?: number;
  height?: number;
}

export function GraphCanvas({
  nodes,
  edges,
  focalNodeId,
  selectedNodeId,
  showImplicitEdges,
  filterOverlay,
  onSelectNode,
  onExpandNode,
  onViewBeacon,
  width = 900,
  height = 600,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: width, h: height });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ mx: number; my: number; vx: number; vy: number } | null>(null);

  // Filter edges based on implicit toggle
  const visibleEdges = useMemo(() => {
    if (showImplicitEdges) return edges;
    return edges.filter((e) => e.edge_type !== 'implicit');
  }, [edges, showImplicitEdges]);

  // Run force layout
  const positionedNodes = useMemo(() => {
    if (nodes.length === 0) return [];

    // Scale the initial layout circle with node count so larger graphs
    // don't start stacked on a tiny 180 px ring.
    const initialRadius = Math.max(180, Math.sqrt(nodes.length) * 60);

    const layoutNodes: LayoutNode[] = initializePositions(
      nodes.map((n) => ({
        id: n.id,
        x: 0,
        y: 0,
        radius: nodeRadius(n),
        pinned: n.id === focalNodeId,
      })),
      width,
      height,
      initialRadius,
    );

    // Pin focal node to center
    if (focalNodeId) {
      const focal = layoutNodes.find((n) => n.id === focalNodeId);
      if (focal) {
        focal.x = width / 2;
        focal.y = height / 2;
        focal.pinned = true;
      }
    }

    const layoutEdges: LayoutEdge[] = visibleEdges.map((e) => ({
      source: e.source_id,
      target: e.target_id,
    }));

    const settled = runForceLayout(layoutNodes, layoutEdges, {
      iterations: Math.min(400, 100 + 4 * nodes.length),
      repulsion: 3500,
      attraction: 0.025,
      idealLength: 200,
      // When there's a focal node it's already pinned to center; the
      // centering force would just fight repulsion and drag siblings back
      // onto the focal node. Near-zero gets us the behavior the user wants.
      centering: focalNodeId ? 0.0001 : 0.01,
    });

    return settled.map((pos) => {
      const original = nodes.find((n) => n.id === pos.id)!;
      return {
        ...original,
        x: pos.x,
        y: pos.y,
        radius: nodeRadius(original),
      } as PositionedNode;
    });
  }, [nodes, visibleEdges, focalNodeId, width, height]);

  // Auto-fit viewBox to content
  useEffect(() => {
    if (positionedNodes.length === 0) return;
    const pad = 80;
    let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    for (const n of positionedNodes) {
      minX = Math.min(minX, n.x - n.radius);
      minY = Math.min(minY, n.y - n.radius);
      maxX = Math.max(maxX, n.x + n.radius);
      maxY = Math.max(maxY, n.y + n.radius);
    }
    setViewBox({
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    });
  }, [positionedNodes]);

  // Node lookup for edges
  const nodeMap = useMemo(() => {
    const m = new Map<string, PositionedNode>();
    for (const n of positionedNodes) m.set(n.id, n);
    return m;
  }, [positionedNodes]);

  // Check if a node matches the filter overlay
  const isNodeDimmed = useCallback(
    (node: GraphNode) => {
      if (!filterOverlay) return false;
      const { status, tags } = filterOverlay;
      if (status.length > 0 && !status.includes(node.status)) return true;
      if (tags.length > 0 && !tags.some((t) => node.tags.includes(t))) return true;
      return false;
    },
    [filterOverlay],
  );

  // Selected node for popover
  const selectedNode = useMemo(
    () => (selectedNodeId ? positionedNodes.find((n) => n.id === selectedNodeId) ?? null : null),
    [selectedNodeId, positionedNodes],
  );

  // Screen coords of selected node (relative to SVG container)
  const selectedNodeScreenPos = useMemo(() => {
    if (!selectedNode || !svgRef.current) return null;
    const svgRect = svgRef.current.getBoundingClientRect();
    // Map graph coords to screen coords via viewBox
    const sx = ((selectedNode.x - viewBox.x) / viewBox.w) * svgRect.width;
    const sy = ((selectedNode.y - viewBox.y) / viewBox.h) * svgRect.height;
    return { x: sx, y: sy };
  }, [selectedNode, viewBox]);

  // ── Interaction handlers ──────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    setViewBox((vb) => {
      const cx = vb.x + vb.w / 2;
      const cy = vb.y + vb.h / 2;
      const nw = vb.w * factor;
      const nh = vb.h * factor;
      return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    });
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Only start pan if clicking on SVG background (not a node)
    if ((e.target as Element).tagName === 'svg' || (e.target as Element).tagName === 'rect') {
      setIsPanning(true);
      panStart.current = { mx: e.clientX, my: e.clientY, vx: viewBox.x, vy: viewBox.y };
    }
  }, [viewBox]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning || !panStart.current || !svgRef.current) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - panStart.current.mx) / svgRect.width) * viewBox.w;
    const dy = ((e.clientY - panStart.current.my) / svgRect.height) * viewBox.h;
    setViewBox((vb) => ({
      ...vb,
      x: panStart.current!.vx - dx,
      y: panStart.current!.vy - dy,
    }));
  }, [isPanning, viewBox.w, viewBox.h]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    panStart.current = null;
  }, []);

  const handleNodeClick = useCallback(
    (id: string) => {
      if (selectedNodeId === id) {
        // Double-click behavior: expand
        const node = nodeMap.get(id);
        if (node) onExpandNode(node.id, node.title);
      } else {
        onSelectNode(id);
      }
    },
    [selectedNodeId, nodeMap, onSelectNode, onExpandNode],
  );

  const handleBackgroundClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  // Detect dark mode
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  if (positionedNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-600">
        No nodes to display
      </div>
    );
  }

  return (
    <div className="relative w-full h-full overflow-hidden">
      <svg
        ref={svgRef}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
        className="w-full h-full"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Background click target */}
        <rect
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.w}
          height={viewBox.h}
          fill="transparent"
          onClick={handleBackgroundClick}
        />

        {/* At-risk pulse animation */}
        <defs>
          <filter id="at-risk-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges */}
        <g>
          {visibleEdges.map((edge, i) => {
            const source = nodeMap.get(edge.source_id);
            const target = nodeMap.get(edge.target_id);
            if (!source || !target) return null;

            const color = edgeColor(edge.edge_type, edge.link_type);
            const dashed = edgeDashed(edge.edge_type, edge.link_type);
            const dimmed =
              isNodeDimmed(source) || isNodeDimmed(target);

            return (
              <line
                key={`${edge.source_id}-${edge.target_id}-${i}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke={color}
                strokeWidth={edge.edge_type === 'implicit' ? 1 : 1.5}
                strokeDasharray={dashed ? '6 4' : undefined}
                opacity={dimmed ? 0.15 : 0.6}
              />
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {positionedNodes.map((node) => {
            const dimmed = isNodeDimmed(node);
            const ring = nodeRingColor(node);
            const fill = isDark ? nodeFillColorDark(node.status) : nodeFillColor(node.status);
            const isFocal = node.id === focalNodeId;
            const isSelected = node.id === selectedNodeId;
            const atRisk = isAtRisk(node);
            const labelMaxLen = 30;
            const label =
              node.title.length > labelMaxLen
                ? node.title.slice(0, labelMaxLen - 1) + '\u2026'
                : node.title;

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                opacity={dimmed ? 0.25 : 1}
                style={{ cursor: dimmed ? 'default' : 'pointer' }}
                onClick={(e) => {
                  if (dimmed) return;
                  e.stopPropagation();
                  handleNodeClick(node.id);
                }}
              >
                {/* At-risk pulsing ring */}
                {atRisk && !dimmed && (
                  <circle
                    r={node.radius + 6}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="2"
                    opacity="0.5"
                    filter="url(#at-risk-glow)"
                  >
                    <animate
                      attributeName="opacity"
                      values="0.5;0.15;0.5"
                      dur="2s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="r"
                      values={`${node.radius + 4};${node.radius + 8};${node.radius + 4}`}
                      dur="2s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}

                {/* Ring (freshness/status) */}
                <circle
                  r={node.radius + 2}
                  fill="none"
                  stroke={ring}
                  strokeWidth={isSelected || isFocal ? 3 : 2}
                />

                {/* Node body */}
                <circle
                  r={node.radius}
                  fill={fill}
                  stroke={isSelected ? '#6366f1' : 'none'}
                  strokeWidth={isSelected ? 2 : 0}
                />

                {/* Focal indicator */}
                {isFocal && (
                  <circle
                    r={4}
                    cx={0}
                    cy={-node.radius - 8}
                    fill="#6366f1"
                  />
                )}

                {/* Label */}
                <text
                  y={node.radius + 14}
                  textAnchor="middle"
                  className="text-[11px] font-medium"
                  fill={isDark ? '#d4d4d8' : '#3f3f46'}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Node popover */}
      {selectedNode && selectedNodeScreenPos && (
        <NodePopover
          node={selectedNode}
          position={selectedNodeScreenPos}
          onClose={() => onSelectNode(null)}
          onViewBeacon={onViewBeacon}
          onExploreFromHere={onExpandNode}
        />
      )}
    </div>
  );
}
