/**
 * usePipelineSync — live pipeline board updates via WebSocket (T1).
 *
 * Connects to bond-api's realtime hub (nginx exposes it at /bond/ws),
 * subscribes to the active pipeline, and invalidates the deals + summary
 * queries whenever a deal event arrives — so a second viewer of the same
 * pipeline sees drags/creates/closes within ~200ms instead of on manual
 * refresh.
 *
 * Self-echo is intentionally NOT filtered: the mutating client already
 * refetched via the mutation's onSuccess, so the WS-triggered refetch is a
 * cheap no-op for them and doubles as self-heal if an optimistic update ever
 * drifts. Mirrors blueprint's use-diagram-sync.
 *
 * Backward-compatible: if the WS never connects (endpoint not deployed), the
 * board behaves exactly as before — manual/refetch-on-action only.
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const INVALIDATE_DEBOUNCE_MS = 200;

export function usePipelineSync(pipelineId: string | null | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!pipelineId || typeof window === 'undefined') return;

    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer: number | null = null;
    let invalidateTimer: number | null = null;

    const scheduleInvalidate = () => {
      if (invalidateTimer !== null) window.clearTimeout(invalidateTimer);
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = null;
        void queryClient.invalidateQueries({ queryKey: ['bond', 'deals'] });
        void queryClient.invalidateQueries({ queryKey: ['bond', 'analytics'] });
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (closed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/bond/ws`);

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        socket?.send(JSON.stringify({ type: 'subscribe', pipeline_id: pipelineId }));
      };

      socket.onmessage = (event) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(event.data)) as { type?: string };
        } catch {
          return;
        }
        // Only deal events trigger a refetch; ignore ping/subscribed/error.
        if (!msg.type || !msg.type.startsWith('bond.deal.')) return;
        scheduleInvalidate();
      };

      socket.onclose = () => {
        socket = null;
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };

      socket.onerror = () => {
        try {
          socket?.close();
        } catch {
          /* already closing */
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (invalidateTimer !== null) window.clearTimeout(invalidateTimer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    };
  }, [pipelineId, queryClient]);
}
