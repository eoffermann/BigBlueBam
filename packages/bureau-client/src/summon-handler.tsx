/**
 * SummonHandler — surfaces incoming summons as a Join/Stay toast.
 *
 * Mounted by mountBureauClient() inside the SDK's portal root. Listens for
 * `summon_incoming` frames on the WS client, queues them, and renders the
 * top-of-stack toast described in §4.4. On Join, navigates via the host
 * adapter (opts.navigate) and pushes `summon_respond { decision: 'join' }`.
 * On Stay (or 30s timeout / auto-follow countdown elapsing without a
 * cancel), pushes `summon_respond { decision: 'stay' }`.
 *
 * If `summon_incoming.autoFollow` is true, the toast renders the 3-second
 * cancelable auto-navigate per §10 step 5.
 *
 * SEMANTIC SHIFT (v2 unified-call model — Phase 3).
 *
 *   v1 used to append `?lkRoom={summon.lkRoomHint}` to the destination URL
 *   so the destination SPA's per-app audio controls could join a specific
 *   LiveKit room (typically the summoner's bureau-room) for continuous-audio
 *   handoff. That mechanism is dead:
 *
 *     - The bureau-client SDK on the destination owns audio now. It joins
 *       whichever room the unified call manager resolves on URL change
 *       (either a spatial bureau-room — if the user is still in one — or
 *       the canonical surface huddle).
 *     - The per-app audio routes that used to read `?lkRoom=` were deleted
 *       in Phase 2 (board-api/audio.routes.ts, brief-api/audio.routes.ts).
 *
 *   We therefore navigate to the bare `targetUrl` and let the SDK pick the
 *   right room. The summon's `lkRoomHint` field stays on the wire for now
 *   because the audit row (`bureau_summons.livekit_room_hint`) still records
 *   it for traceability, but the client no longer encodes it into the URL.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BureauWsClient } from './ws-client.js';
import type { SummonIncomingEvent } from './types.js';

// ─────────────────────────────────────────────────────────────────────────

export interface SummonHandlerProps {
  client: BureauWsClient;
  /** Host-app navigation callback (router.push(stripOrigin(url))). */
  navigate: (url: string) => void;
  /** Auto-follow countdown in seconds; defaults to 3 per §10 step 5. */
  autoFollowSeconds?: number;
}

interface QueuedSummon extends SummonIncomingEvent {
  /** Local id — falls back to summonId. */
  localId: string;
  /** Wall-clock when received; used to drive timeouts. */
  receivedAt: number;
}

const TIMEOUT_MS = 30_000;

function stripOrigin(url: string): string {
  // The host adapter is also free to strip origin; we still do it as a
  // defense-in-depth so absolute summon URLs work with HashRouter etc.
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://x/');
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Inline styles — kept here so consumers don't need a Tailwind pipeline to
// see the toast. Hosts can restyle by targeting [data-bureau-summon-toast]
// in their own CSS.
// ─────────────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'fixed',
  bottom: 88,
  right: 16,
  zIndex: 2147483646,
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

const labelStyle: CSSProperties = {
  opacity: 0.75,
  marginTop: 2,
  fontSize: 12,
};

const btnRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
};

const btnPrimaryStyle: CSSProperties = {
  flex: 1,
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
  fontWeight: 600,
};

const btnSecondaryStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  color: '#e4e4e7',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  padding: '6px 10px',
  cursor: 'pointer',
};

const countdownStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  opacity: 0.75,
};

// ─────────────────────────────────────────────────────────────────────────

export function SummonHandler({
  client,
  navigate,
  autoFollowSeconds = 3,
}: SummonHandlerProps): React.ReactElement | null {
  const [queue, setQueue] = useState<QueuedSummon[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // Subscribe to summon_incoming.
  useEffect(() => {
    const off = client.on('summon_incoming', (msg) => {
      const next: QueuedSummon = {
        ...msg,
        localId: msg.summonId || `s_${Date.now()}_${Math.random()}`,
        receivedAt: Date.now(),
      };
      setQueue((q) => [...q, next]);
    });
    return off;
  }, [client]);

  // 30s auto-stay timeout per summon (covers the "ignored" case).
  // biome-ignore lint/correctness/useExhaustiveDependencies(queue.map): timers deliberately re-arm only when the queue COUNT changes; keying on the array identity would reset every countdown on unrelated queue updates.
  useEffect(() => {
    if (queue.length === 0) return;
    const timers = queue.map((s) => {
      const elapsed = Date.now() - s.receivedAt;
      const remaining = Math.max(0, TIMEOUT_MS - elapsed);
      return setTimeout(() => {
        respond(s, 'stay');
      }, remaining);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.length]);

  function respond(summon: QueuedSummon, decision: 'join' | 'stay') {
    // Send the decision exactly once per summon; the queue removal
    // serves as the dedup gate.
    setQueue((q) => {
      if (!q.some((s) => s.localId === summon.localId)) return q;
      try {
        client.send({
          type: 'summon_respond',
          summonId: summon.summonId,
          decision,
        });
      } catch {
        // ignore — disconnects swallow this; the server will GC the offer.
      }
      if (decision === 'join') {
        // v2 unified-call model: navigate to the bare URL. The bureau-client
        // SDK on the destination resolves the right LiveKit room from
        // describeLocation() on its own; we no longer encode `?lkRoom=` into
        // the URL because the per-app audio routes that consumed it are
        // gone after Phase 2.
        try {
          navigate(stripOrigin(summon.targetUrl));
        } catch {
          // host adapter rejected the navigation; nothing we can do here
        }
      }
      return q.filter((s) => s.localId !== summon.localId);
    });
  }

  if (queue.length === 0) return null;

  return (
    <div style={overlayStyle} data-bureau-summon-overlay>
      {queue.map((s) => (
        <SummonToast
          key={s.localId}
          summon={s}
          autoFollowSeconds={autoFollowSeconds}
          onJoin={() => respond(s, 'join')}
          onStay={() => respond(s, 'stay')}
        />
      ))}
    </div>
  );
}

interface ToastProps {
  summon: QueuedSummon;
  autoFollowSeconds: number;
  onJoin: () => void;
  onStay: () => void;
}

function SummonToast({
  summon,
  autoFollowSeconds,
  onJoin,
  onStay,
}: ToastProps): React.ReactElement {
  const [autoRemaining, setAutoRemaining] = useState<number | null>(
    summon.autoFollow ? autoFollowSeconds : null,
  );
  const cancelledRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the countdown re-arms per summon identity (localId) and must NOT restart when the parent re-renders with a fresh onJoin closure — onJoin is intentionally read at fire time.
  useEffect(() => {
    if (!summon.autoFollow) return;
    cancelledRef.current = false;
    const start = Date.now();
    const total = autoFollowSeconds * 1000;
    const tick = () => {
      if (cancelledRef.current) return;
      const elapsed = Date.now() - start;
      const remainingMs = Math.max(0, total - elapsed);
      setAutoRemaining(Math.ceil(remainingMs / 1000));
      if (remainingMs <= 0) {
        onJoin();
        return;
      }
      window.setTimeout(tick, 200);
    };
    const t = window.setTimeout(tick, 200);
    return () => {
      cancelledRef.current = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summon.localId, summon.autoFollow, autoFollowSeconds]);

  const cancelAuto = () => {
    cancelledRef.current = true;
    setAutoRemaining(null);
  };

  const labelLine = summon.label
    ? `"${summon.label}"${summon.app ? ` (${summon.app})` : ''}`
    : summon.app
      ? `(${summon.app})`
      : summon.targetUrl;

  return (
    <output style={cardStyle} data-bureau-summon-toast>
      <div style={titleStyle}>Summon</div>
      <div style={bodyStyle}>
        {summon.summoner?.name ?? 'Someone'} pulled the room to
      </div>
      <div style={labelStyle}>{labelLine}</div>
      {autoRemaining !== null ? (
        <div style={countdownStyle}>
          Going in {autoRemaining}s…{' '}
          <button
            type="button"
            onClick={cancelAuto}
            style={{
              background: 'transparent',
              color: '#93c5fd',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
              font: 'inherit',
            }}
          >
            cancel
          </button>
        </div>
      ) : null}
      <div style={btnRowStyle}>
        <button type="button" style={btnPrimaryStyle} onClick={onJoin}>
          Join
        </button>
        <button type="button" style={btnSecondaryStyle} onClick={onStay}>
          Stay here
        </button>
      </div>
    </output>
  );
}
