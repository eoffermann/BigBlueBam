import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

// Live structured-data editing: subscribe to an asset over the Bin WS hub. When
// anyone commits an edit we invalidate the data query so the editor refetches
// the fresh version, and we track a lightweight presence roster (who else is in
// the editor). Edits still go through the REST mutations (each mints a version).

export interface PresenceMember {
  conn_id: string;
  user_id: string;
  name: string;
  color: string;
}

function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export function useBinRealtime(assetId: string | undefined): { members: PresenceMember[] } {
  const qc = useQueryClient();
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const selfConnRef = useRef<string | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!assetId) {
      setMembers([]);
      return;
    }
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(wsUrl('/bin/ws'));
      ws.onopen = () => {
        retryRef.current = 0;
        ws?.send(JSON.stringify({ type: 'subscribe', asset_id: assetId }));
      };
      ws.onmessage = (e) => {
        let msg: {
          type?: string;
          conn_id?: string;
          user_id?: string;
          name?: string;
          color?: string;
          members?: PresenceMember[];
        };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case 'subscribed':
            selfConnRef.current = msg.conn_id ?? null;
            break;
          case 'bin.data.updated':
            qc.invalidateQueries({ queryKey: ['bin', 'data', assetId] });
            qc.invalidateQueries({ queryKey: ['bin', 'assets', assetId] });
            break;
          case 'bin.presence.roster':
            setMembers((msg.members ?? []).filter((m) => m.conn_id !== selfConnRef.current));
            break;
          case 'bin.presence.join':
            if (msg.conn_id && msg.conn_id !== selfConnRef.current) {
              const joined: PresenceMember = {
                conn_id: msg.conn_id,
                user_id: msg.user_id ?? '',
                name: msg.name ?? 'Someone',
                color: msg.color ?? '#64748b',
              };
              setMembers((prev) =>
                prev.some((p) => p.conn_id === joined.conn_id) ? prev : [...prev, joined],
              );
            }
            break;
          case 'bin.presence.leave':
            setMembers((prev) => prev.filter((p) => p.conn_id !== msg.conn_id));
            break;
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setMembers([]); // a fresh roster arrives on reconnect
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
  }, [assetId, qc]);

  return { members };
}
