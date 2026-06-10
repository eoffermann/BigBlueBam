/**
 * KnockHandler — surfaces incoming knocks on the office owner's user channel.
 *
 * Mounted by mountBureauClient(). Listens for `knock_incoming` frames, queues
 * one toast per knock, and offers the three §4.3 buttons:
 *
 *   - Let in   → knock_respond { decision: 'admit'   }
 *   - Not now  → knock_respond { decision: 'defer'   }
 *   - Decline  → knock_respond { decision: 'decline' }
 *
 * No answer in 30s auto-defers (matches §4.3 "auto Not now").
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BureauWsClient } from './ws-client.js';
import type { KnockIncomingEvent, KnockDecision } from './types.js';

// ─────────────────────────────────────────────────────────────────────────

export interface KnockHandlerProps {
  client: BureauWsClient;
  /** Hook for hosts that want their own "knock acknowledged" callback. */
  onKnockResolved?: (knockId: string, decision: KnockDecision) => void;
}

interface QueuedKnock extends KnockIncomingEvent {
  localId: string;
  receivedAt: number;
}

const AUTO_DEFER_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────
// Inline styles — match the summon toast palette so a stacked toast looks
// like one widget rather than two themes glued together.
// ─────────────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  bottom: 88,
  right: 16,
  zIndex: 2147483645,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'none',
};

const cardStyle: CSSProperties = {
  pointerEvents: 'auto',
  minWidth: 280,
  maxWidth: 360,
  background: 'rgba(24, 24, 27, 0.95)',
  color: '#fafafa',
  borderRadius: 10,
  padding: '12px 14px',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSize: 13,
  lineHeight: 1.45,
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  opacity: 0.6,
  marginBottom: 4,
};

const bodyStyle: CSSProperties = {
  fontWeight: 500,
};

const messageStyle: CSSProperties = {
  opacity: 0.75,
  marginTop: 4,
  fontSize: 12,
  fontStyle: 'italic',
};

const btnRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 10,
};

const btnAdmitStyle: CSSProperties = {
  flex: 1,
  background: '#16a34a',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
  fontWeight: 600,
};

const btnDeferStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  color: '#e4e4e7',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
};

const btnDeclineStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  color: '#fca5a5',
  border: '1px solid rgba(252, 165, 165, 0.35)',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
};

// ─────────────────────────────────────────────────────────────────────────

export function KnockHandler({
  client,
  onKnockResolved,
}: KnockHandlerProps): React.ReactElement | null {
  const [queue, setQueue] = useState<QueuedKnock[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  useEffect(() => {
    const off = client.on('knock_incoming', (msg) => {
      const next: QueuedKnock = {
        ...msg,
        localId: msg.knockId || `k_${Date.now()}_${Math.random()}`,
        receivedAt: Date.now(),
      };
      setQueue((q) => [...q, next]);
    });
    return off;
  }, [client]);

  // Server also fires `knock_resolved` when somebody else (e.g. the timeout
  // sweeper) resolves the knock; drop the toast so we don't leak stale UI.
  useEffect(() => {
    const off = client.on('knock_resolved', (msg) => {
      setQueue((q) => q.filter((k) => k.knockId !== msg.knockId));
    });
    return off;
  }, [client]);

  // 30s auto-defer per knock.
  useEffect(() => {
    if (queue.length === 0) return;
    const timers = queue.map((k) => {
      const elapsed = Date.now() - k.receivedAt;
      const remaining = Math.max(0, AUTO_DEFER_MS - elapsed);
      return setTimeout(() => {
        respond(k, 'defer');
      }, remaining);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  function respond(knock: QueuedKnock, decision: KnockDecision) {
    setQueue((q) => {
      if (!q.some((k) => k.localId === knock.localId)) return q;
      try {
        client.send({
          type: 'knock_respond',
          knockId: knock.knockId,
          decision,
        });
      } catch {
        // ignore — see ws-client; the next reconnect doesn't replay this.
      }
      try {
        onKnockResolved?.(knock.knockId, decision);
      } catch {
        // host callback should not break the queue update
      }
      return q.filter((k) => k.localId !== knock.localId);
    });
  }

  if (queue.length === 0) return null;

  return (
    <div style={overlayStyle} data-bureau-knock-overlay>
      {queue.map((k) => (
        <KnockToast
          key={k.localId}
          knock={k}
          onAdmit={() => respond(k, 'admit')}
          onDefer={() => respond(k, 'defer')}
          onDecline={() => respond(k, 'decline')}
        />
      ))}
    </div>
  );
}

interface ToastProps {
  knock: QueuedKnock;
  onAdmit: () => void;
  onDefer: () => void;
  onDecline: () => void;
}

function KnockToast({
  knock,
  onAdmit,
  onDefer,
  onDecline,
}: ToastProps): React.ReactElement {
  const visitor = knock.visitor?.name ?? 'Someone';
  return (
    <div style={cardStyle} data-bureau-knock-toast role="status">
      <div style={titleStyle}>Knock</div>
      <div style={bodyStyle}>{visitor} is knocking</div>
      {knock.message ? <div style={messageStyle}>"{knock.message}"</div> : null}
      <div style={btnRowStyle}>
        <button type="button" style={btnAdmitStyle} onClick={onAdmit}>
          Let in
        </button>
        <button type="button" style={btnDeferStyle} onClick={onDefer}>
          Not now
        </button>
        <button type="button" style={btnDeclineStyle} onClick={onDecline}>
          Decline
        </button>
      </div>
    </div>
  );
}
