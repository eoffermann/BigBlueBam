import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Live review updates: subscribe to a review version over the Bay WS hub and
// invalidate the annotation/decision queries when anyone (member or guest)
// changes them, so concurrent reviewers see each other's marks without a manual
// refresh. Read-only — all writes still go through the REST mutations.

function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export function useBayRealtime(versionId: string | undefined): void {
  const qc = useQueryClient();
  const retryRef = useRef(0);

  useEffect(() => {
    if (!versionId) return;
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl('/bay/ws'));
      ws.onopen = () => {
        retryRef.current = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', version_id: versionId }));
      };
      ws.onmessage = (e) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (msg.type === 'bay.annotation.created' || msg.type === 'bay.annotation.resolved') {
          qc.invalidateQueries({ queryKey: ['bay', 'annotations', versionId] });
        } else if (msg.type === 'bay.decision.set') {
          qc.invalidateQueries({ queryKey: ['bay', 'decisions', versionId] });
        }
      };
      ws.onclose = () => {
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
  }, [versionId, qc]);
}
