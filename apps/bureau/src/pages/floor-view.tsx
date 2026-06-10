/**
 * Floor view — §4.1 of the bureau design doc.
 *
 * Renders the floor as a Canvas2D scene:
 *   - One rectangle per room, pulled from floor.layout.rooms[roomId].
 *   - Occupant dots inside each rectangle, driven by the bureau-store's
 *     `occupants` map, which the useBureauWs hook keeps in sync over WS.
 *
 * Interaction:
 *   - Click a room → enterRoom() via the local WS client.
 *   - Hover paints a slightly thicker border via the renderer's isHover.
 *
 * Layout fallback: if floor.layout.rooms is missing or empty (a fresh seed
 * floor, an unmigrated floor, …) we auto-grid the rooms left-to-right in a
 * 4-column flow so the floor is still navigable while Agent B's editor is
 * in flight.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LogOut } from 'lucide-react';
import { useFloor } from '@/hooks/use-floors';
import { useBureauWs } from '@/hooks/use-bureau-ws';
import { useBureauStore, type FloorLayoutRect, type FloorRoomSummary } from '@/stores/bureau-store';
import { drawRoomRect, hitTestRect } from '@/components/floor/room-rect';
import { useAuthStore } from '@/stores/auth.store';

interface FloorViewPageProps {
  floorId: string;
  /** Reported back to the layout so the header breadcrumb can show the name. */
  onFloorLoaded?: (name: string) => void;
}

/**
 * If the editor hasn't placed a room yet, generate a deterministic grid
 * position so the floor still renders meaningfully. 4 columns × n rows,
 * room rectangles 240×140 with a 24 px gutter, starting at (40, 40).
 */
function autoLayout(rooms: FloorRoomSummary[]): Record<string, FloorLayoutRect> {
  const COLS = 4;
  const RW = 240;
  const RH = 140;
  const GAP = 24;
  const OX = 40;
  const OY = 40;
  const out: Record<string, FloorLayoutRect> = {};
  rooms.forEach((r, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    out[r.id] = {
      x: OX + col * (RW + GAP),
      y: OY + row * (RH + GAP),
      w: RW,
      h: RH,
    };
  });
  return out;
}

export function FloorViewPage({ floorId, onFloorLoaded }: FloorViewPageProps) {
  const { data: floor, isLoading, error } = useFloor(floorId);
  const { status, enterRoom, leaveRoom } = useBureauWs(floor?.id ?? null);
  const setActiveFloor = useBureauStore((s) => s.setActiveFloor);
  const occupants = useBureauStore((s) => s.occupants);
  const userToRoom = useBureauStore((s) => s.userToRoom);
  const reset = useBureauStore((s) => s.reset);
  const selfUserId = useAuthStore((s) => s.user?.id ?? null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [hoverRoomId, setHoverRoomId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });

  // Hand the floor to the store; reset on unmount.
  useEffect(() => {
    if (floor) {
      setActiveFloor(floor);
      onFloorLoaded?.(floor.name);
    }
    return () => {
      reset();
    };
  }, [floor, setActiveFloor, reset, onFloorLoaded]);

  // Resize-observer for the canvas wrapper.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setSize({ w: Math.max(320, r.width), h: Math.max(240, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!floor) return {};
    const fromServer = floor.layout?.rooms;
    if (fromServer && Object.keys(fromServer).length > 0) return fromServer;
    return autoLayout(floor.rooms ?? []);
  }, [floor]);

  // The "logical" viewport the layout was authored against. Falls back to a
  // bounding box around all rooms so auto-layout floors still fit.
  const logicalViewport = useMemo(() => {
    if (floor?.layout?.viewport) return floor.layout.viewport;
    let maxX = 0;
    let maxY = 0;
    for (const rect of Object.values(layout)) {
      maxX = Math.max(maxX, rect.x + rect.w);
      maxY = Math.max(maxY, rect.y + rect.h);
    }
    return { w: Math.max(maxX + 40, 800), h: Math.max(maxY + 40, 600) };
  }, [floor, layout]);

  // The scale that fits the logical viewport into the canvas, preserving
  // aspect ratio. Min 0.3, max 1.5.
  const fitScale = useMemo(() => {
    const sx = size.w / logicalViewport.w;
    const sy = size.h / logicalViewport.h;
    return Math.max(0.3, Math.min(1.5, Math.min(sx, sy)));
  }, [size, logicalViewport]);

  // Paint loop. We don't requestAnimationFrame in a tight loop — every state
  // change re-runs this effect, which is enough for v1 (occupancy moves at
  // human-typing speed, not 60 fps).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !floor) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    const isDark = document.documentElement.classList.contains('dark');
    ctx.fillStyle = isDark ? '#09090b' : '#fafafa';
    ctx.fillRect(0, 0, size.w, size.h);

    // Subtle grid
    ctx.strokeStyle = isDark ? '#27272a' : '#e4e4e7';
    ctx.lineWidth = 1;
    const grid = 32;
    ctx.beginPath();
    for (let x = 0; x < size.w; x += grid) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, size.h);
    }
    for (let y = 0; y < size.h; y += grid) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(size.w, y + 0.5);
    }
    ctx.stroke();

    // Apply scale-and-center transform.
    ctx.save();
    const offsetX = (size.w - logicalViewport.w * fitScale) / 2;
    const offsetY = (size.h - logicalViewport.h * fitScale) / 2;
    ctx.translate(offsetX, offsetY);
    ctx.scale(fitScale, fitScale);

    // Self's current room (from the SDK's userToRoom mirror).
    const selfRoomId = selfUserId ? userToRoom[selfUserId] : null;

    for (const room of floor.rooms ?? []) {
      const rect = layout[room.id];
      if (!rect) continue;
      const set = occupants[room.id] ?? new Set<string>();
      drawRoomRect(ctx, {
        rect,
        name: room.name,
        capacity: null,
        occupants: Array.from(set),
        isSelf: selfRoomId === room.id,
        isHover: hoverRoomId === room.id,
        isDark,
      });
    }
    ctx.restore();
  }, [
    floor,
    layout,
    size,
    fitScale,
    logicalViewport,
    occupants,
    hoverRoomId,
    userToRoom,
    selfUserId,
  ]);

  /** Translate a mouse event into logical-space coords and hit-test. */
  const findRoomAt = (clientX: number, clientY: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas || !floor) return null;
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const offsetX = (size.w - logicalViewport.w * fitScale) / 2;
    const offsetY = (size.h - logicalViewport.h * fitScale) / 2;
    const lx = (px - offsetX) / fitScale;
    const ly = (py - offsetY) / fitScale;
    for (const room of floor.rooms ?? []) {
      const rect = layout[room.id];
      if (!rect) continue;
      if (hitTestRect(rect, lx, ly)) return room.id;
    }
    return null;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error || !floor) {
    return (
      <div className="p-8">
        <div className="text-sm text-red-600 dark:text-red-400">
          Failed to load floor: {(error as Error | undefined)?.message ?? 'Not found'}
        </div>
      </div>
    );
  }

  const selfRoomId = selfUserId ? userToRoom[selfUserId] : null;

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {floor.name}
          </h1>
          <span
            className={
              status === 'connected'
                ? 'text-xs text-emerald-600 dark:text-emerald-400'
                : 'text-xs text-amber-600 dark:text-amber-400'
            }
          >
            {status === 'connected' ? 'Live' : status}
          </span>
        </div>
        {selfRoomId ? (
          <button
            onClick={() => leaveRoom()}
            className="inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5"
          >
            <LogOut className="h-3.5 w-3.5" />
            Leave room
          </button>
        ) : null}
      </div>

      {/* Canvas wrapper */}
      <div
        ref={wrapperRef}
        className="flex-1 relative overflow-hidden bg-canvas dark:bg-canvas-dark"
      >
        <canvas
          ref={canvasRef}
          className="floor-canvas absolute inset-0"
          onMouseMove={(e) => {
            const id = findRoomAt(e.clientX, e.clientY);
            setHoverRoomId(id);
          }}
          onMouseLeave={() => setHoverRoomId(null)}
          onClick={(e) => {
            const id = findRoomAt(e.clientX, e.clientY);
            if (id) enterRoom(id);
          }}
        />
      </div>
    </div>
  );
}
