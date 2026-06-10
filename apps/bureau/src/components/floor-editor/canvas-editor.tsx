/**
 * Canvas2D editor surface for floor zone editing.
 *
 * Pure interaction layer. Owns:
 *   - pan/zoom on wheel + middle-drag (or shift+drag)
 *   - click-drag to draw a new rect (when a "draw" tool is active)
 *   - click on an existing rect to select it
 *   - drag a selected rect to move it
 *   - drag a corner handle to resize
 *   - snap-to-grid at 12px in world coordinates
 *
 * Geometry is driven entirely by the `zones` prop. Selection is also
 * lifted (so the parent can sync the right-panel inspector). The parent
 * is responsible for re-rendering after a mutation by passing a new
 * `zones` array; the canvas does not own zone state.
 *
 * Coordinate spaces:
 *   world coords  → the natural units of the floor (matches the bureau
 *                   layout JSONB: `width`, `height`, and zone `x/y/w/h`).
 *   screen coords → DOM pixels inside the wrapping div. Mapping is
 *                   `screen = world * scale + offset`.
 *
 * The grid (12px world units) is rendered at the world-space spacing so
 * zooming in/out keeps it logical, not "12 px on screen".
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { Zone } from './zone-types';

const GRID = 12; // world units
const HANDLE_PX = 8; // resize-handle hit radius in screen pixels
const MIN_ZONE_SIZE = 24; // world units (floor)
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

export type EditorTool = 'select' | 'draw-room' | 'draw-office';

export interface CanvasEditorProps {
  width: number; // world width
  height: number; // world height
  zones: Zone[];
  selectedZoneId: string | null;
  /** Optional MinIO underlay URL. Drawn beneath everything when set. */
  backgroundUrl?: string | null;
  /** Currently active tool. */
  tool: EditorTool;
  onSelectZone: (id: string | null) => void;
  /** Called when a drag/draw/resize settles. The parent persists. */
  onZonesChange: (zones: Zone[]) => void;
  /** Called when a brand-new zone is committed (after click-drag draw). */
  onDrawComplete: (
    zone: Omit<Zone, 'id' | 'label'> & { kind: 'room' | 'office' },
  ) => void;
}

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

type Interaction =
  | { kind: 'idle' }
  | { kind: 'pan'; startScreenX: number; startScreenY: number; startOx: number; startOy: number }
  | {
      kind: 'draw';
      tool: 'draw-room' | 'draw-office';
      startWorldX: number;
      startWorldY: number;
      currentWorldX: number;
      currentWorldY: number;
    }
  | {
      kind: 'move';
      zoneId: string;
      startMouseWorldX: number;
      startMouseWorldY: number;
      startZoneX: number;
      startZoneY: number;
    }
  | {
      kind: 'resize';
      zoneId: string;
      handle: 'nw' | 'ne' | 'sw' | 'se';
      startZoneX: number;
      startZoneY: number;
      startZoneW: number;
      startZoneH: number;
    };

export function CanvasEditor({
  width,
  height,
  zones,
  selectedZoneId,
  backgroundUrl,
  tool,
  onSelectZone,
  onZonesChange,
  onDrawComplete,
}: CanvasEditorProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImgRef = useRef<HTMLImageElement | null>(null);
  const [bgReady, setBgReady] = useState(false);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const interactionRef = useRef<Interaction>({ kind: 'idle' });
  const [_, forceRender] = useState(0);
  const repaint = useCallback(() => forceRender((n) => n + 1), []);

  // Resize observer for the wrap → canvas pixel size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setSize({ w: Math.max(1, Math.round(cr.width)), h: Math.max(1, Math.round(cr.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Initial fit: center the floor on first layout.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (size.w < 2 || size.h < 2 || width < 1 || height < 1) return;
    didFitRef.current = true;
    const fit = Math.min((size.w - 40) / width, (size.h - 40) / height, 1);
    const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
    setScale(s);
    setOffset({ x: (size.w - width * s) / 2, y: (size.h - height * s) / 2 });
  }, [size.w, size.h, width, height]);

  // Background image loader. Re-runs when backgroundUrl changes.
  useEffect(() => {
    if (!backgroundUrl) {
      bgImgRef.current = null;
      setBgReady(false);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgImgRef.current = img;
      setBgReady(true);
      repaint();
    };
    img.onerror = () => {
      bgImgRef.current = null;
      setBgReady(false);
    };
    img.src = backgroundUrl;
    return () => {
      // Detach onload so a quick swap doesn't paint a stale image.
      img.onload = null;
      img.onerror = null;
    };
  }, [backgroundUrl, repaint]);

  // World <-> screen helpers (stable, recomputed on render).
  const worldToScreen = useCallback(
    (wx: number, wy: number) => ({ x: wx * scale + offset.x, y: wy * scale + offset.y }),
    [scale, offset.x, offset.y],
  );
  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({ x: (sx - offset.x) / scale, y: (sy - offset.y) / scale }),
    [scale, offset.x, offset.y],
  );

  // Paint loop — re-runs on any state change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    }
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    // --- Floor background (a soft tile + a border) ----------------------
    const tl = worldToScreen(0, 0);
    const br = worldToScreen(width, height);
    ctx.fillStyle = '#f4f4f5';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // Optional MinIO underlay
    if (bgReady && bgImgRef.current) {
      try {
        ctx.drawImage(bgImgRef.current, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      } catch {
        // ignore: tainted canvas etc.
      }
    }

    // --- Grid ----------------------------------------------------------
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const stepScreen = GRID * scale;
    if (stepScreen >= 4) {
      // Verticals
      for (let x = 0; x <= width; x += GRID) {
        const s = worldToScreen(x, 0);
        ctx.moveTo(s.x + 0.5, tl.y);
        ctx.lineTo(s.x + 0.5, br.y);
      }
      // Horizontals
      for (let y = 0; y <= height; y += GRID) {
        const s = worldToScreen(0, y);
        ctx.moveTo(tl.x, s.y + 0.5);
        ctx.lineTo(br.x, s.y + 0.5);
      }
      ctx.stroke();
    }

    // Floor border
    ctx.strokeStyle = '#a1a1aa';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    // --- Zones ---------------------------------------------------------
    for (const z of zones) {
      const a = worldToScreen(z.x, z.y);
      const sw = z.w * scale;
      const sh = z.h * scale;
      const isSelected = z.id === selectedZoneId;
      ctx.fillStyle = z.kind === 'office' ? 'rgba(99, 102, 241, 0.12)' : 'rgba(59, 130, 246, 0.10)';
      ctx.strokeStyle = isSelected ? '#2563eb' : '#52525b';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.fillRect(a.x, a.y, sw, sh);
      ctx.strokeRect(a.x, a.y, sw, sh);

      // Door tick (small chip on top edge).
      ctx.fillStyle = isSelected ? '#2563eb' : '#71717a';
      ctx.fillRect(a.x + sw / 2 - 6, a.y - 3, 12, 4);

      // Label
      if (sw > 50 && sh > 24) {
        ctx.fillStyle = '#27272a';
        ctx.font = '12px system-ui, -apple-system, sans-serif';
        ctx.textBaseline = 'top';
        const label = z.label || z.kind;
        ctx.fillText(label, a.x + 6, a.y + 6, sw - 12);
      }

      // Selection handles
      if (isSelected) {
        const corners: Array<[number, number]> = [
          [a.x, a.y],
          [a.x + sw, a.y],
          [a.x, a.y + sh],
          [a.x + sw, a.y + sh],
        ];
        ctx.fillStyle = '#2563eb';
        for (const [cx, cy] of corners) {
          ctx.fillRect(cx - HANDLE_PX / 2, cy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        }
      }
    }

    // --- In-progress draw rect (pending commit) -----------------------
    const it = interactionRef.current;
    if (it.kind === 'draw') {
      const x = Math.min(it.startWorldX, it.currentWorldX);
      const y = Math.min(it.startWorldY, it.currentWorldY);
      const w = Math.abs(it.currentWorldX - it.startWorldX);
      const h = Math.abs(it.currentWorldY - it.startWorldY);
      const a = worldToScreen(snap(x), snap(y));
      ctx.strokeStyle = '#2563eb';
      ctx.fillStyle = 'rgba(37, 99, 235, 0.10)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(a.x, a.y, snap(w) * scale, snap(h) * scale);
      ctx.strokeRect(a.x, a.y, snap(w) * scale, snap(h) * scale);
      ctx.setLineDash([]);
    }
  }, [size.w, size.h, scale, offset.x, offset.y, zones, selectedZoneId, width, height, bgReady, worldToScreen]);

  // --- Pointer handlers --------------------------------------------------

  // Detect which corner handle (if any) is under a screen point for the
  // currently selected zone. Returns null if not on a handle.
  const hitHandle = useCallback(
    (sx: number, sy: number): 'nw' | 'ne' | 'sw' | 'se' | null => {
      if (!selectedZoneId) return null;
      const zone = zones.find((z) => z.id === selectedZoneId);
      if (!zone) return null;
      const a = worldToScreen(zone.x, zone.y);
      const b = worldToScreen(zone.x + zone.w, zone.y + zone.h);
      const within = (cx: number, cy: number) =>
        Math.abs(sx - cx) <= HANDLE_PX && Math.abs(sy - cy) <= HANDLE_PX;
      if (within(a.x, a.y)) return 'nw';
      if (within(b.x, a.y)) return 'ne';
      if (within(a.x, b.y)) return 'sw';
      if (within(b.x, b.y)) return 'se';
      return null;
    },
    [selectedZoneId, zones, worldToScreen],
  );

  // Find the topmost zone under a screen point.
  const hitZone = useCallback(
    (sx: number, sy: number): Zone | null => {
      const w = screenToWorld(sx, sy);
      // Iterate reverse so the top (last-painted) zone wins.
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i]!;
        if (w.x >= z.x && w.x <= z.x + z.w && w.y >= z.y && w.y <= z.y + z.h) {
          return z;
        }
      }
      return null;
    },
    [zones, screenToWorld],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Pan: middle-button or shift+left
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        interactionRef.current = {
          kind: 'pan',
          startScreenX: sx,
          startScreenY: sy,
          startOx: offset.x,
          startOy: offset.y,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      // Resize: only when a corner handle of the selected zone is hit.
      const handle = hitHandle(sx, sy);
      if (handle && selectedZoneId) {
        const zone = zones.find((z) => z.id === selectedZoneId)!;
        interactionRef.current = {
          kind: 'resize',
          zoneId: selectedZoneId,
          handle,
          startZoneX: zone.x,
          startZoneY: zone.y,
          startZoneW: zone.w,
          startZoneH: zone.h,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }

      // Draw-new: when a draw tool is active and the click is inside the
      // floor area (negative coords get clamped on commit).
      if (tool === 'draw-room' || tool === 'draw-office') {
        const world = screenToWorld(sx, sy);
        interactionRef.current = {
          kind: 'draw',
          tool,
          startWorldX: world.x,
          startWorldY: world.y,
          currentWorldX: world.x,
          currentWorldY: world.y,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        repaint();
        return;
      }

      // Move-or-select: click on a zone → if selected, move; else select.
      const z = hitZone(sx, sy);
      if (z) {
        if (z.id !== selectedZoneId) {
          onSelectZone(z.id);
          // First click selects without dragging. Subsequent press-down
          // on the same zone moves.
          interactionRef.current = { kind: 'idle' };
          return;
        }
        const world = screenToWorld(sx, sy);
        interactionRef.current = {
          kind: 'move',
          zoneId: z.id,
          startMouseWorldX: world.x,
          startMouseWorldY: world.y,
          startZoneX: z.x,
          startZoneY: z.y,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }

      // Nothing hit → clear selection.
      onSelectZone(null);
    },
    [tool, hitHandle, hitZone, screenToWorld, selectedZoneId, zones, offset.x, offset.y, onSelectZone, repaint],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const it = interactionRef.current;
      if (it.kind === 'idle') return;
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (it.kind === 'pan') {
        setOffset({
          x: it.startOx + (sx - it.startScreenX),
          y: it.startOy + (sy - it.startScreenY),
        });
        return;
      }

      const world = screenToWorld(sx, sy);
      if (it.kind === 'draw') {
        interactionRef.current = {
          ...it,
          currentWorldX: world.x,
          currentWorldY: world.y,
        };
        repaint();
        return;
      }

      if (it.kind === 'move') {
        const dx = world.x - it.startMouseWorldX;
        const dy = world.y - it.startMouseWorldY;
        const next = zones.map((z) =>
          z.id === it.zoneId
            ? {
                ...z,
                x: snap(Math.max(0, it.startZoneX + dx)),
                y: snap(Math.max(0, it.startZoneY + dy)),
              }
            : z,
        );
        onZonesChange(next);
        return;
      }

      if (it.kind === 'resize') {
        const idx = zones.findIndex((z) => z.id === it.zoneId);
        if (idx < 0) return;
        const z = zones[idx]!;
        let x = z.x;
        let y = z.y;
        let w = z.w;
        let h = z.h;
        if (it.handle === 'nw') {
          const nx = Math.min(snap(world.x), it.startZoneX + it.startZoneW - MIN_ZONE_SIZE);
          const ny = Math.min(snap(world.y), it.startZoneY + it.startZoneH - MIN_ZONE_SIZE);
          x = Math.max(0, nx);
          y = Math.max(0, ny);
          w = it.startZoneX + it.startZoneW - x;
          h = it.startZoneY + it.startZoneH - y;
        } else if (it.handle === 'ne') {
          const ny = Math.min(snap(world.y), it.startZoneY + it.startZoneH - MIN_ZONE_SIZE);
          y = Math.max(0, ny);
          w = Math.max(MIN_ZONE_SIZE, snap(world.x - it.startZoneX));
          h = it.startZoneY + it.startZoneH - y;
        } else if (it.handle === 'sw') {
          const nx = Math.min(snap(world.x), it.startZoneX + it.startZoneW - MIN_ZONE_SIZE);
          x = Math.max(0, nx);
          w = it.startZoneX + it.startZoneW - x;
          h = Math.max(MIN_ZONE_SIZE, snap(world.y - it.startZoneY));
        } else {
          w = Math.max(MIN_ZONE_SIZE, snap(world.x - it.startZoneX));
          h = Math.max(MIN_ZONE_SIZE, snap(world.y - it.startZoneY));
        }
        const next = zones.map((zz) => (zz.id === it.zoneId ? { ...zz, x, y, w, h } : zz));
        onZonesChange(next);
        return;
      }
    },
    [screenToWorld, zones, onZonesChange, repaint],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const it = interactionRef.current;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (it.kind === 'draw') {
        const x = snap(Math.max(0, Math.min(it.startWorldX, it.currentWorldX)));
        const y = snap(Math.max(0, Math.min(it.startWorldY, it.currentWorldY)));
        const w = snap(Math.abs(it.currentWorldX - it.startWorldX));
        const h = snap(Math.abs(it.currentWorldY - it.startWorldY));
        interactionRef.current = { kind: 'idle' };
        if (w >= MIN_ZONE_SIZE && h >= MIN_ZONE_SIZE) {
          onDrawComplete({
            x,
            y,
            w,
            h,
            shape: 'rect',
            kind: it.tool === 'draw-office' ? 'office' : 'room',
          });
        } else {
          repaint();
        }
        return;
      }
      interactionRef.current = { kind: 'idle' };
    },
    [onDrawComplete, repaint],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const dir = e.deltaY < 0 ? 1 : -1;
      const factor = dir > 0 ? 1.1 : 1 / 1.1;
      const nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale * factor));
      if (nextScale === scale) return;
      // Keep the point under the cursor stable in world space.
      const worldBefore = screenToWorld(sx, sy);
      const nextOffset = {
        x: sx - worldBefore.x * nextScale,
        y: sy - worldBefore.y * nextScale,
      };
      setScale(nextScale);
      setOffset(nextOffset);
    },
    [scale, screenToWorld],
  );

  // Computed cursor — provides a visual cue for what a click will do.
  const cursor = useMemo<CSSProperties['cursor']>(() => {
    if (tool === 'draw-room' || tool === 'draw-office') return 'crosshair';
    return 'default';
  }, [tool]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        style={{ cursor, touchAction: 'none', display: 'block' }}
      />
      <div className="absolute bottom-2 left-2 rounded-md bg-white/90 dark:bg-zinc-800/90 text-[10px] text-zinc-600 dark:text-zinc-300 px-2 py-1 shadow-sm pointer-events-none">
        {Math.round(scale * 100)}% · scroll = zoom · shift+drag = pan
      </div>
    </div>
  );
}
