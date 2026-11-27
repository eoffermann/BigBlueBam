import { useEffect, useRef, useState, useCallback } from 'react';
import { bursarServerFrameSchema, type BursarClientFrame, type BursarServerFrame } from '@bigbluebam/shared';

// Realtime client for /bursar/ws (spec 11.1), served by bursar-api's hub. Rooms are org:<id> and
// request:<id>; the hub refuses vendor:<id> rooms (reserved by the spec until a server event
// targets them). Server events: scope.progress (chunk n/N), leveling.progress (offer n/N only;
// node and window progress are on the polled run row), matrix.updated, plus the hub's ready,
// subscribed and error control frames.
//
// The frame contract is @bigbluebam/shared's bursar-realtime schemas (#374), the same ones
// bursar-api publishes with. Every incoming message is safeParsed against it, and a frame that does
// not match is dropped, so pages switch on a typed union instead of bare strings.
//
// Exponential backoff (1s base, capped 30s, jittered) with a visible "reconnecting" state. The
// stream is NOT the source of truth: GET /requests/:id/leveling-runs polled at 5s
// (useLevelingRuns) is authoritative, and a frame only makes the UI refetch sooner. If the
// socket drops, it retries under the cap and the poll carries progress meanwhile.

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export type BursarRealtimeEvent = BursarServerFrame;

/** Parse one raw WebSocket message into a contract frame, or null when it is not one. */
export function parseBursarFrame(raw: unknown): BursarServerFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null; // non-JSON frames (heartbeats) are ignored
  }
  const parsed = bursarServerFrameSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
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
        const subscribe: BursarClientFrame = { type: 'subscribe', rooms: roomKey ? roomKey.split(',') : [] };
        ws.send(JSON.stringify(subscribe));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (evt) => {
      const frame = parseBursarFrame(evt.data);
      if (frame) onEventRef.current?.(frame);
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
