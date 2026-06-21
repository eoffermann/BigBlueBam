/**
 * Renders a colored ring around nodes that OTHER viewers have selected (T3).
 * Uses each node's flow position/size from the current rfNodes, transformed to
 * screen space with the viewport so the ring tracks pan/zoom. Pure overlay
 * (pointer-events off). Edge-selection highlighting is intentionally out of
 * scope for this pass — see docs/plans/synchronous-presence-rollout-notes.md.
 */
import { useViewport, type Node } from '@xyflow/react';
import type { RemoteSelection } from '@/hooks/use-diagram-awareness';

const DEFAULT_W = 160;
const DEFAULT_H = 44;

export function RemoteSelectionOverlay({
  selections,
  nodes,
}: {
  selections: RemoteSelection[];
  nodes: Node[];
}) {
  const { x, y, zoom } = useViewport();
  if (selections.length === 0) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 49 }}>
      {selections.flatMap((sel) =>
        sel.nodeIds.map((nid) => {
          const node = byId.get(nid);
          if (!node) return null;
          const w = (node.measured?.width ?? node.width ?? DEFAULT_W) * zoom;
          const h = (node.measured?.height ?? node.height ?? DEFAULT_H) * zoom;
          const sx = node.position.x * zoom + x;
          const sy = node.position.y * zoom + y;
          return (
            <div
              key={`${sel.userId}:${nid}`}
              className="absolute top-0 left-0 rounded"
              style={{
                transform: `translate(${sx}px, ${sy}px)`,
                width: w,
                height: h,
                border: `2px solid ${sel.color}`,
                boxShadow: `0 0 0 1px ${sel.color}55`,
              }}
            >
              <div
                className="absolute -top-4 left-0 whitespace-nowrap rounded px-1 text-[9px] font-medium text-white"
                style={{ backgroundColor: sel.color }}
              >
                {sel.name}
              </div>
            </div>
          );
        }),
      )}
    </div>
  );
}
