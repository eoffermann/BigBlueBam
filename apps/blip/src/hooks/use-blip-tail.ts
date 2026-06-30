import { useCallback, useEffect, useRef, useState } from 'react';
import type { BlipEntry, PredicateTree } from '@/hooks/use-blip';

// Live tail over the Blip WS gateway (Blip Design §8). Opens a socket to
// /blip/ws, subscribes to one (tracked_app_id, report_type) with a compiled
// filter, then renders a rolling buffer of matching entries: a `backfill`
// page on connect, then live `entry` messages, with `sampling` notices under
// backpressure. Exponential-backoff reconnect; resume from the highest seq seen.

function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

interface BackfillMsg { type: 'backfill'; entries: BlipEntry[] }
interface EntryMsg { type: 'entry'; entry: BlipEntry }
interface SamplingMsg { type: 'sampling'; dropped_per_sec: number }
interface ErrorMsg { type: 'error'; code?: string; message?: string }
type TailMsg = BackfillMsg | EntryMsg | SamplingMsg | ErrorMsg;

export interface UseBlipTailOptions {
  trackedAppId: string | undefined;
  reportType: string | undefined;
  filter?: PredicateTree | null;
  /** Cap the in-memory rolling buffer. */
  maxEntries?: number;
  /** Start paused (e.g. for a stable screenshot of the backfill). */
  initiallyPaused?: boolean;
}

export interface UseBlipTailResult {
  entries: BlipEntry[];
  connected: boolean;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Drop rate reported by the gateway when sampling under backpressure. */
  droppedPerSec: number;
  error: string | null;
  clear: () => void;
}

function seqNum(s: number | string): number {
  return typeof s === 'number' ? s : Number(s);
}

export function useBlipTail({
  trackedAppId,
  reportType,
  filter,
  maxEntries = 500,
  initiallyPaused = false,
}: UseBlipTailOptions): UseBlipTailResult {
  const [entries, setEntries] = useState<BlipEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(initiallyPaused);
  const [droppedPerSec, setDroppedPerSec] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Refs so the socket callbacks read live values without resubscribing.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const sinceSeqRef = useRef<number | undefined>(undefined);
  const retryRef = useRef(0);

  const clear = useCallback(() => {
    setEntries([]);
    sinceSeqRef.current = undefined;
  }, []);

  // Serialize the filter so a stable object identity does not churn the socket.
  const filterKey = filter ? JSON.stringify(filter) : '';

  useEffect(() => {
    if (!trackedAppId || !reportType) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const pushEntry = (entry: BlipEntry) => {
      const s = seqNum(entry.seq);
      if (sinceSeqRef.current === undefined || s > sinceSeqRef.current) {
        sinceSeqRef.current = s;
      }
      // While paused, freeze the on-screen stream (buffer nothing, §8.3).
      if (pausedRef.current) return;
      setEntries((prev) => {
        const next = [entry, ...prev];
        return next.length > maxEntries ? next.slice(0, maxEntries) : next;
      });
    };

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl('/blip/ws'));

      ws.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
        setError(null);
        ws?.send(
          JSON.stringify({
            type: 'subscribe',
            tracked_app_id: trackedAppId,
            report_type: reportType,
            filter: filter ?? undefined,
            since_seq: sinceSeqRef.current,
          }),
        );
      };

      ws.onmessage = (e) => {
        let msg: TailMsg;
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === 'backfill') {
          // Backfill arrives seq asc; render newest-first like the live stream.
          const ordered = [...msg.entries].sort((a, b) => seqNum(b.seq) - seqNum(a.seq));
          for (const en of msg.entries) {
            const s = seqNum(en.seq);
            if (sinceSeqRef.current === undefined || s > sinceSeqRef.current) {
              sinceSeqRef.current = s;
            }
          }
          setEntries(ordered.slice(0, maxEntries));
        } else if (msg.type === 'entry') {
          pushEntry(msg.entry);
        } else if (msg.type === 'sampling') {
          setDroppedPerSec(msg.dropped_per_sec ?? 0);
        } else if (msg.type === 'error') {
          setError(msg.message ?? msg.code ?? 'tail error');
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(30_000, 1000 * 2 ** retryRef.current++);
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedAppId, reportType, filterKey, maxEntries]);

  return { entries, connected, paused, setPaused, droppedPerSec, error, clear };
}
