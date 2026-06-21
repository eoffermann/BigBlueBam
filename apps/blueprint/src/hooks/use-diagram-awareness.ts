/**
 * useDiagramAwareness — T3 ephemeral awareness for the Blueprint editor:
 * live remote cursors + selection highlights over a dedicated WebSocket.
 *
 * This opens its OWN socket to /blueprint/ws and subscribes on the separate
 * `awareness` channel, so it is completely decoupled from use-diagram-sync
 * (the structural-mutation socket). Cursor traffic therefore never touches the
 * graph-refetch path, and if this socket fails the editor is unaffected — the
 * hook just returns empty arrays and no-op senders.
 *
 * Nothing here is persisted: cursors fade on idle, and a peer's cursor +
 * selection clear when they leave (server emits `left` on socket close).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface RemoteCursor {
  userId: string;
  name: string;
  color: string;
  x: number; // flow coordinates
  y: number;
  updatedAt: number;
}

export interface RemoteSelection {
  userId: string;
  name: string;
  color: string;
  nodeIds: string[];
  edgeIds: string[];
}

interface AwarenessApi {
  cursors: RemoteCursor[];
  selections: RemoteSelection[];
  sendCursor: (x: number, y: number) => void;
  sendSelection: (nodeIds: string[], edgeIds: string[]) => void;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const CURSOR_THROTTLE_MS = 50; // ~20 Hz max
const STALE_CURSOR_MS = 8000;
const STALE_SWEEP_MS = 3000;

export function useDiagramAwareness(diagramId: string | undefined): AwarenessApi {
  const [cursors, setCursors] = useState<RemoteCursor[]>([]);
  const [selections, setSelections] = useState<RemoteSelection[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const selectionsRef = useRef<Map<string, RemoteSelection>>(new Map());
  // Throttle bookkeeping for outgoing cursor frames.
  const lastSentRef = useRef(0);
  const pendingTimerRef = useRef<number | null>(null);
  const pendingPointRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!diagramId || typeof window === 'undefined') return;

    let closed = false;
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer: number | null = null;

    cursorsRef.current.clear();
    selectionsRef.current.clear();
    setCursors([]);
    setSelections([]);

    const flushCursors = () => setCursors(Array.from(cursorsRef.current.values()));
    const flushSelections = () => setSelections(Array.from(selectionsRef.current.values()));

    const connect = () => {
      if (closed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/blueprint/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        socket.send(
          JSON.stringify({ type: 'subscribe', diagram_id: diagramId, channel: 'awareness' }),
        );
      };

      socket.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = msg.type as string | undefined;
        if (type === 'blueprint.awareness.cursor') {
          cursorsRef.current.set(msg.user_id as string, {
            userId: msg.user_id as string,
            name: (msg.name as string) ?? 'Someone',
            color: (msg.color as string) ?? '#3b82f6',
            x: msg.x as number,
            y: msg.y as number,
            updatedAt: Date.now(),
          });
          flushCursors();
        } else if (type === 'blueprint.awareness.selection') {
          selectionsRef.current.set(msg.user_id as string, {
            userId: msg.user_id as string,
            name: (msg.name as string) ?? 'Someone',
            color: (msg.color as string) ?? '#3b82f6',
            nodeIds: (msg.node_ids as string[]) ?? [],
            edgeIds: (msg.edge_ids as string[]) ?? [],
          });
          flushSelections();
        } else if (type === 'blueprint.awareness.left') {
          const uid = msg.user_id as string;
          cursorsRef.current.delete(uid);
          selectionsRef.current.delete(uid);
          flushCursors();
          flushSelections();
        }
      };

      socket.onclose = () => {
        socketRef.current = null;
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };

      socket.onerror = () => {
        try {
          socket.close();
        } catch {
          /* already closing */
        }
      };
    };

    // Drop cursors that haven't updated recently (idle/gone). Selections
    // persist until an explicit `left`, so an idle peer keeps their highlight.
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - STALE_CURSOR_MS;
      let changed = false;
      for (const [uid, c] of cursorsRef.current) {
        if (c.updatedAt < cutoff) {
          cursorsRef.current.delete(uid);
          changed = true;
        }
      }
      if (changed) flushCursors();
    }, STALE_SWEEP_MS);

    connect();

    return () => {
      closed = true;
      window.clearInterval(sweep);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
      try {
        socketRef.current?.close();
      } catch {
        /* already closed */
      }
      socketRef.current = null;
    };
  }, [diagramId]);

  const sendCursor = useCallback(
    (x: number, y: number) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !diagramId) return;
      const now = Date.now();
      const flush = () => {
        const pt = pendingPointRef.current;
        pendingPointRef.current = null;
        pendingTimerRef.current = null;
        lastSentRef.current = Date.now();
        const s = socketRef.current;
        if (!pt || !s || s.readyState !== WebSocket.OPEN) return;
        s.send(JSON.stringify({ type: 'cursor', diagram_id: diagramId, x: pt.x, y: pt.y }));
      };
      pendingPointRef.current = { x, y };
      const elapsed = now - lastSentRef.current;
      if (elapsed >= CURSOR_THROTTLE_MS) {
        flush();
      } else if (pendingTimerRef.current === null) {
        pendingTimerRef.current = window.setTimeout(flush, CURSOR_THROTTLE_MS - elapsed);
      }
    },
    [diagramId],
  );

  const sendSelection = useCallback(
    (nodeIds: string[], edgeIds: string[]) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !diagramId) return;
      socket.send(
        JSON.stringify({ type: 'selection', diagram_id: diagramId, node_ids: nodeIds, edge_ids: edgeIds }),
      );
    },
    [diagramId],
  );

  return { cursors, selections, sendCursor, sendSelection };
}
