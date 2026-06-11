/**
 * VideoTilesWindow — floating multi-feed video panel.
 *
 * Sits alongside the docked call box. Auto-shows when the active call has
 * at least one video track (remote camera, remote screen-share, or local
 * camera self-preview); auto-hides when none. Independently draggable,
 * collapsible, and persisted across reloads via localStorage.
 *
 * Design intent (project owner's note 2026-06-11): "for most collab I'm
 * less interested in seeing faces than documents." Screen-share tiles
 * dominate the layout — they take the full top row at 2x height while
 * face cams fill the remaining grid below. With zero shares it falls back
 * to an even auto-grid.
 *
 * The component is a thin React shell over `useActiveCall().videoTiles`.
 * All track lifecycle logic lives in the per-tile <VideoTile> component
 * via track.attach/detach against a single <video> ref.
 */

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { VideoTile as VideoTileInfo } from './active-room.js';
import { useActiveCall } from './use-active-call.js';

const STORAGE_KEY = 'bureau.video-tiles';
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 280;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 160;

interface PanelPos {
  x: number | null;
  y: number | null;
  w: number;
  h: number;
  collapsed: boolean;
}

// Dismissal is per-call (keyed by the LiveKit room name) and per-tab. It
// purposely does NOT persist to localStorage — leaving and re-joining a
// room should bring the panel back. Holding the dismissal in a module
// ref keeps it sticky across re-renders while a single call lasts.
interface DismissState {
  /** roomName the user dismissed for, or null when not dismissed. */
  key: string | null;
  /** Tile count at dismiss time. If new tiles appear after, we restore
   *  so a freshly-shared screen or a newly-joining participant isn't
   *  silently hidden. */
  tileCount: number;
}

const DEFAULT_POS: PanelPos = {
  x: null,
  y: null,
  w: DEFAULT_WIDTH,
  h: DEFAULT_HEIGHT,
  collapsed: false,
};

function loadPos(): PanelPos {
  if (typeof window === 'undefined') return DEFAULT_POS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POS;
    const parsed = JSON.parse(raw) as Partial<PanelPos>;
    return {
      x: typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : null,
      w:
        typeof parsed.w === 'number' && parsed.w >= MIN_WIDTH
          ? Math.min(parsed.w, 1600)
          : DEFAULT_WIDTH,
      h:
        typeof parsed.h === 'number' && parsed.h >= MIN_HEIGHT
          ? Math.min(parsed.h, 1200)
          : DEFAULT_HEIGHT,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return DEFAULT_POS;
  }
}

function savePos(pos: PanelPos): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {
    /* full / privacy mode — non-fatal */
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Layout — split screen-share tiles from cam tiles. The window stacks them
// vertically: shares row first (≥1 → takes top 60%), cams row below in an
// auto-grid. With zero shares cams fill the whole panel.
// ─────────────────────────────────────────────────────────────────────────

function gridTemplate(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

// ─────────────────────────────────────────────────────────────────────────
// Public component
// ─────────────────────────────────────────────────────────────────────────

export function VideoTilesWindow(): React.ReactElement | null {
  const call = useActiveCall();
  const [pos, setPos] = useState<PanelPos>(loadPos);
  const [dragging, setDragging] = useState(false);
  const [dismiss, setDismiss] = useState<DismissState>({ key: null, tileCount: 0 });
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  useEffect(() => {
    savePos(pos);
  }, [pos]);

  const tiles = call.videoTiles;
  const roomKey = call.target.roomName;

  // Reset dismissal whenever the call moves to a different room (or ends).
  // We do this in an effect rather than a derived value so the state lives
  // in one place and stays consistent across re-renders.
  useEffect(() => {
    if (dismiss.key !== null && dismiss.key !== roomKey) {
      setDismiss({ key: null, tileCount: 0 });
    }
  }, [roomKey, dismiss.key]);

  const dismissed =
    dismiss.key !== null &&
    dismiss.key === roomKey &&
    tiles.length <= dismiss.tileCount;

  const hasTiles = call.status === 'connected' && tiles.length > 0;
  const visible = hasTiles && !dismissed;

  const handleDismiss = useCallback(() => {
    if (!roomKey) return;
    setDismiss({ key: roomKey, tileCount: tiles.length });
  }, [roomKey, tiles.length]);

  const handleRestore = useCallback(() => {
    setDismiss({ key: null, tileCount: 0 });
  }, []);

  // Re-clamp on viewport resize so a dragged panel can't strand off-screen.
  useEffect(() => {
    if (!visible) return;
    const onResize = () => {
      setPos((p) => {
        if (p.x === null || p.y === null) return p;
        const w = boxRef.current?.offsetWidth ?? p.w;
        const h = boxRef.current?.offsetHeight ?? p.h;
        const cx = Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - w));
        const cy = Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - h));
        if (cx === p.x && cy === p.y) return p;
        return { ...p, x: cx, y: cy };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [visible]);

  const onHeaderPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: e.pointerId,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
    };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }, []);

  const onHeaderPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const w = boxRef.current?.offsetWidth ?? DEFAULT_WIDTH;
    const h = boxRef.current?.offsetHeight ?? DEFAULT_HEIGHT;
    const x = Math.min(Math.max(0, e.clientX - drag.dx), Math.max(0, window.innerWidth - w));
    const y = Math.min(Math.max(0, e.clientY - drag.dy), Math.max(0, window.innerHeight - h));
    setPos((p) => ({ ...p, x, y }));
  }, []);

  const onHeaderPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === e.pointerId) {
      dragStateRef.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* release is best-effort */
      }
    }
  }, []);

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const el = boxRef.current;
      if (!el) return;
      resizeStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startW: el.offsetWidth,
        startH: el.offsetHeight,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      e.stopPropagation();
    },
    [],
  );

  const onResizePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const r = resizeStateRef.current;
    if (!r || r.pointerId !== e.pointerId) return;
    const w = Math.max(MIN_WIDTH, r.startW + (e.clientX - r.startX));
    const h = Math.max(MIN_HEIGHT, r.startH + (e.clientY - r.startY));
    setPos((p) => ({ ...p, w, h }));
    e.stopPropagation();
  }, []);

  const onResizePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeStateRef.current?.pointerId === e.pointerId) {
      resizeStateRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setPos((p) => ({ ...p, collapsed: !p.collapsed }));
  }, []);

  const { shares, cams } = useMemo(() => {
    const s: VideoTileInfo[] = [];
    const c: VideoTileInfo[] = [];
    for (const t of tiles) (t.source === 'screen' ? s : c).push(t);
    return { shares: s, cams: c };
  }, [tiles]);

  if (!visible) {
    // Dismissed-but-call-still-has-tiles: render a tiny restore chip in
    // the bottom-right so the user has an undo path without leaving the
    // call. When the call ends or the user moves rooms the chip vanishes
    // along with the panel itself.
    if (hasTiles && dismissed) {
      return (
        <button
          type="button"
          onClick={handleRestore}
          aria-label="Show video feeds"
          title={`Show ${tiles.length} video feed${tiles.length === 1 ? '' : 's'}`}
          data-bureau-video-restore
          style={{
            position: 'fixed',
            right: 16,
            bottom: 200,
            zIndex: 999998,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            borderRadius: 999,
            border: '1px solid rgba(148, 163, 184, 0.35)',
            background: 'rgba(15, 23, 42, 0.92)',
            color: '#e2e8f0',
            fontFamily: 'system-ui, sans-serif',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
          }}
        >
          <span aria-hidden="true">📹</span>
          {tiles.length} feed{tiles.length === 1 ? '' : 's'}
        </button>
      );
    }
    return null;
  }

  // Position styling: anchor bottom-right by default (above the docked
  // call box, which itself sits at bottom-right with no x/y persisted);
  // explicit coords once the user drags.
  const dragged = pos.x !== null && pos.y !== null;
  const positionStyle: CSSProperties = dragged
    ? {
        position: 'fixed',
        left: pos.x ?? undefined,
        top: pos.y ?? undefined,
        right: 'auto',
        bottom: 'auto',
      }
    : { position: 'fixed', right: 16, bottom: 200 };

  const containerStyle: CSSProperties = {
    ...positionStyle,
    width: pos.collapsed ? 220 : pos.w,
    height: pos.collapsed ? 32 : pos.h,
    background: 'rgba(15, 23, 42, 0.95)',
    color: '#e2e8f0',
    border: '1px solid rgba(148, 163, 184, 0.25)',
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 12,
    zIndex: 999998,
    cursor: dragging ? 'grabbing' : undefined,
    userSelect: 'none',
  };

  const headerStyle: CSSProperties = {
    height: 32,
    padding: '0 8px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderBottom: pos.collapsed ? 'none' : '1px solid rgba(148, 163, 184, 0.2)',
    cursor: dragging ? 'grabbing' : 'grab',
    background: 'rgba(30, 41, 59, 0.9)',
    flexShrink: 0,
  };

  const titleStyle: CSSProperties = {
    flex: 1,
    fontWeight: 600,
    letterSpacing: 0.2,
    color: '#cbd5e1',
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const btnStyle: CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: '#cbd5e1',
    cursor: 'pointer',
    padding: '0 6px',
    height: 22,
    borderRadius: 4,
  };

  const camGrid = gridTemplate(cams.length);

  return (
    <section
      ref={boxRef}
      style={containerStyle}
      aria-label="Video feeds"
      data-bureau-video-window
    >
      <div
        style={headerStyle}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span style={titleStyle}>
          {tiles.length === 1
            ? '1 video feed'
            : `${tiles.length} video feeds`}
          {shares.length > 0 ? ' · screen' : ''}
        </span>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={pos.collapsed ? 'Expand video feeds' : 'Collapse video feeds'}
          style={btnStyle}
        >
          {pos.collapsed ? '▢' : '–'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          title="Hide video feeds for this call"
          aria-label="Hide video feeds"
          data-bureau-video-close
          style={btnStyle}
        >
          ×
        </button>
      </div>

      {!pos.collapsed && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {shares.length > 0 && (
            <div
              style={{
                flex: cams.length > 0 ? '0 0 60%' : 1,
                display: 'grid',
                gap: 4,
                padding: 4,
                gridTemplateColumns: `repeat(${Math.min(shares.length, 2)}, 1fr)`,
                gridAutoRows: '1fr',
                minHeight: 0,
              }}
            >
              {shares.map((t) => (
                <VideoTile key={t.sid} tile={t} prominent />
              ))}
            </div>
          )}
          {cams.length > 0 && (
            <div
              style={{
                flex: shares.length > 0 ? '0 0 40%' : 1,
                display: 'grid',
                gap: 4,
                padding: 4,
                gridTemplateColumns: `repeat(${camGrid.cols}, 1fr)`,
                gridAutoRows: '1fr',
                minHeight: 0,
              }}
            >
              {cams.map((t) => (
                <VideoTile key={t.sid} tile={t} prominent={false} />
              ))}
            </div>
          )}
          <div
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 16,
              height: 16,
              cursor: 'se-resize',
              background:
                'linear-gradient(135deg, transparent 50%, rgba(148, 163, 184, 0.6) 50%)',
            }}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            aria-label="Resize video feeds"
            data-bureau-video-resize
            role="separator"
          />
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// One tile = one <video> + attach/detach via LiveKit's Track.attach API
// ─────────────────────────────────────────────────────────────────────────

interface VideoTileProps {
  tile: VideoTileInfo;
  /** Screen-share tiles render contain (so the whole document is visible).
   *  Camera tiles render cover (filling the box). */
  prominent: boolean;
}

function VideoTile({ tile, prominent }: VideoTileProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    const track = tile.track;
    if (!el || !track) return;
    try {
      track.attach(el);
    } catch {
      /* attach can throw if the element is already detached */
    }
    // Local self-preview never plays audio (the SDK auto-routes the
    // local mic; remote audio is handled by LiveKit's audio output
    // sink). Mute the element so we don't get feedback loops if a
    // future change accidentally subscribes locally to a remote audio
    // track via this same element.
    el.muted = tile.isLocal;
    el.autoplay = true;
    el.playsInline = true;
    return () => {
      try {
        track.detach(el);
      } catch {
        /* detach can throw if the track is already gone */
      }
    };
  }, [tile.track, tile.isLocal]);

  const containerStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#020617',
    borderRadius: 6,
    overflow: 'hidden',
    minHeight: 0,
  };

  const videoStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: prominent ? 'contain' : 'cover',
    // Self-preview: mirror so movement matches expectation.
    transform: tile.isLocal && tile.source === 'camera' ? 'scaleX(-1)' : undefined,
    background: '#020617',
  };

  const labelStyle: CSSProperties = {
    position: 'absolute',
    left: 4,
    bottom: 4,
    padding: '2px 6px',
    background: 'rgba(15, 23, 42, 0.75)',
    color: '#e2e8f0',
    borderRadius: 4,
    fontSize: 11,
    lineHeight: 1.2,
    pointerEvents: 'none',
    maxWidth: 'calc(100% - 8px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const sourceTag =
    tile.source === 'screen' ? '📺 ' : tile.isLocal ? '👤 ' : '';
  const label = `${sourceTag}${tile.participantName}${tile.isLocal ? ' (you)' : ''}`;

  return (
    <div style={containerStyle} data-bureau-tile data-tile-sid={tile.sid}>
      {tile.track ? (
        <video ref={videoRef} style={videoStyle} />
      ) : (
        <div
          style={{
            ...videoStyle,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#64748b',
            fontSize: 11,
          }}
        >
          {tile.isMuted ? 'paused' : 'connecting…'}
        </div>
      )}
      <span style={labelStyle}>{label}</span>
      {tile.isMuted && (
        <span
          style={{
            position: 'absolute',
            right: 4,
            top: 4,
            padding: '2px 6px',
            background: 'rgba(127, 29, 29, 0.85)',
            color: '#fee2e2',
            borderRadius: 4,
            fontSize: 10,
          }}
        >
          muted
        </span>
      )}
    </div>
  );
}
