import { useEffect, useRef, useState, useCallback } from 'react';

// Realtime client for /bursar/ws (spec 11.1). Rooms are org:<id>, request:<id>, vendor:<id>.
// Server events: scope.progress, leveling.progress (offer n/N, node m/M, window w/W),
// matrix.updated.
//
// There is NO browser-WS precedent in apps/burn/src, so this is written from scratch to the
// spec's contract: exponential backoff (1s base, capped 30s, jittered), a visible "reconnecting"
// state, and - crucially - it is NOT the source of truth. GET /requests/:id/leveling-runs polled
// at 5s (useLevelingRuns) is authoritative; this stream only accelerates the UI. If the WS server
// is not yet mounted the socket simply keeps retrying under the cap and the poll carries progress.

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface BursarRealtimeEvent {
  type: string; // 'scope.progress' | 'leveling.progress' | 'matrix.updated' | ...
  room?: string;
  payload?: Record<string, unknown>;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function wsUrl(rooms: string[]): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const u = new URL(`${proto}://${window.location.host}/bursar/ws`);
  if (rooms.length) u.searchParams.set('rooms', rooms.join(','));
  return u.toString();
}

export function useBursarRealtime(rooms: string[], onEvent?: (e: BursarRealtimeEvent) => void) {
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Stable room key so an inline array literal does not force a reconnect every render.
  const roomKey = rooms.join(',');

  const connect = useCallback(() => {
    if (closedRef.current) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(roomKey ? roomKey.split(',') : []));
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;
    setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

    ws.onopen = () => {
      attemptRef.current = 0;
      setStatus('open');
      // Announce the rooms we want; the server may also read them from the query string.
      try {
        ws.send(JSON.stringify({ type: 'subscribe', rooms: roomKey ? roomKey.split(',') : [] }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data as string) as BursarRealtimeEvent;
        if (data && typeof data.type === 'string') onEventRef.current?.(data);
      } catch {
        // Non-JSON frames (heartbeats) are ignored.
      }
    };

    ws.onerror = () => {
      // onclose follows; the reconnect is scheduled there so we never double-schedule.
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closedRef.current) return;
      scheduleReconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey]);

  const scheduleReconnect = useCallback(() => {
    if (closedRef.current) return;
    setStatus('reconnecting');
    const attempt = attemptRef.current++;
    const capped = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    const jittered = capped * (0.5 + Math.random() * 0.5); // 50-100% of the cap
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => connect(), jittered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  useEffect(() => {
    closedRef.current = false;
    attemptRef.current = 0;
    connect();
    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      setStatus('closed');
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [connect]);

  return { status };
}
