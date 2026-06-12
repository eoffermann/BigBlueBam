/**
 * useDiagramSync — live document sync for the Blueprint editor.
 *
 * Subscribes to the blueprint-api realtime hub (`/blueprint/ws`) for
 * the diagram being edited and invalidates the TanStack Query caches
 * whenever ANY mutation event arrives for it. The editor's existing
 * graph-reconciliation effect does the rest: React Flow state is
 * rebuilt from the refetched graph (selection preserved), while the
 * viewport — pan/zoom — is component-local and never touched, so two
 * people share one document but move around it independently.
 *
 * Design choices:
 *  - Invalidate-and-refetch rather than applying event deltas: the
 *    events carry enough to patch locally, but a refetch from the
 *    relational source of truth can never drift, and the editor
 *    already dedupes no-op refreshes via its content stamp.
 *  - Debounced (200ms trailing) so a burst (auto-layout moving fifty
 *    nodes, a multi-delete cascade) coalesces into one refetch.
 *  - Self-echoes are not filtered: our own mutations already update
 *    the cache via onSuccess invalidations, so the extra refetch is a
 *    cheap no-op — and it doubles as self-healing if an optimistic
 *    update ever drifts from the server.
 *  - Reconnect with capped backoff + resubscribe on every open (the
 *    Railway edge recycles idle websockets; same lesson as the Bureau
 *    presence replay).
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const INVALIDATE_DEBOUNCE_MS = 200;

export function useDiagramSync(diagramId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!diagramId || typeof window === 'undefined') return;

    let socket: WebSocket | null = null;
    let closed = false;
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer: number | null = null;
    let invalidateTimer: number | null = null;

    const scheduleInvalidate = (alsoDiagram: boolean) => {
      if (invalidateTimer !== null) window.clearTimeout(invalidateTimer);
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = null;
        void queryClient.invalidateQueries({
          queryKey: ['blueprint', 'diagrams', diagramId, 'graph'],
        });
        if (alsoDiagram) {
          void queryClient.invalidateQueries({
            queryKey: ['blueprint', 'diagrams', diagramId],
            exact: true,
          });
        }
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (closed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/blueprint/ws`);

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        socket?.send(JSON.stringify({ type: 'subscribe', diagram_id: diagramId }));
      };

      socket.onmessage = (event) => {
        let msg: { type?: string };
        try {
          msg = JSON.parse(String(event.data)) as { type?: string };
        } catch {
          return;
        }
        if (!msg.type || !msg.type.startsWith('blueprint.')) return; // ping/ack/error
        // diagram.updated changes metadata (title, layout algorithm…)
        // shown outside the canvas; everything else is graph content.
        scheduleInvalidate(msg.type === 'blueprint.diagram.updated');
      };

      socket.onclose = () => {
        socket = null;
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };

      socket.onerror = () => {
        // onclose follows and owns the reconnect.
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
  }, [diagramId, queryClient]);
}
