/**
 * Renders other viewers' live cursors over the React Flow canvas (T3).
 * Cursors arrive in flow coordinates; we transform them to screen space with
 * the current viewport so they track pan/zoom. Pure overlay: pointer-events
 * are off, so it can never intercept canvas interaction.
 */
import { useViewport } from '@xyflow/react';
import type { RemoteCursor } from '@/hooks/use-diagram-awareness';

export function RemoteCursorsOverlay({ cursors }: { cursors: RemoteCursor[] }) {
  const { x, y, zoom } = useViewport();
  if (cursors.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 50 }}>
      {cursors.map((c) => {
        const sx = c.x * zoom + x;
        const sy = c.y * zoom + y;
        return (
          <div
            key={c.userId}
            className="absolute top-0 left-0"
            style={{ transform: `translate(${sx}px, ${sy}px)`, transition: 'transform 80ms linear' }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 18 18"
              style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.3))' }}
            >
              <path
                d="M2 2 L2 14 L6 10 L9 16 L11 15 L8 9 L13 9 Z"
                fill={c.color}
                stroke="white"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </svg>
            <div
              className="absolute left-3 top-3 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
              style={{ backgroundColor: c.color }}
            >
              {c.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
