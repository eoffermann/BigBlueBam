/**
 * RingHandler — surfaces incoming surface-scoped huddle rings.
 *
 * Per docs/plans/presence-and-immediate-interaction.md, when a peer clicks
 * "Ring for huddle" from a presence chip strip on a Brief doc / Board canvas
 * / Blueprint diagram / Bond deal / Bam task / Beacon article / Helpdesk
 * ticket, bureau-api fans the ring to the target via `ring_incoming` on
 * their user:{userId} Redis channel. This handler:
 *
 *   1. Renders the shared <IncomingCallOverlay/> from @bigbluebam/ui
 *      (extracted from apps/banter into packages/ui by Agent B in this
 *      same workstream).
 *   2. On Accept: calls the host adapter's `navigate(...)` callback with the
 *      surface URL. The SDK's ActiveCallManager observes the location change
 *      and auto-joins `huddle-{surface_app}-{surface_id}` — there is no
 *      separate token POST here anymore.
 *   3. On Decline / AutoDecline: posts `ring_respond` back through the WS
 *      so the caller's UI can close the outgoing-ring toast.
 *
 * SEMANTIC SHIFT (v2 unified-call model — Phase 3).
 *
 *   The original v1 handler POSTed `/bureau/api/v1/surface-huddle/token` on
 *   accept and appended `?huddle=1` so the destination SPA knew to mount its
 *   own huddle UI. Both are obsolete in the unified-call model:
 *
 *     - The LiveKit room ALREADY exists; the SDK's ActiveCallManager joins
 *       it automatically when describeLocation() returns a surface_id (or a
 *       livekitRoom hint). Acceptors just navigate to the surface URL.
 *     - The destination SPA no longer mounts its own huddle UI — the docked
 *       box is the universal LiveKit endpoint. `?huddle=1` is a no-op.
 *
 *   The handler therefore reduces to: notify the caller of accept/decline
 *   via WS, then navigate. We retain the IncomingCallOverlay UX and the
 *   auto-decline timer; we drop the network round-trip and the query param.
 *
 * The IncomingCallOverlay owns its own auto-decline timer (driven by
 * `autoDeclineMs`). We feed it the smaller of (server-provided expires_at
 * minus now) and a hard cap (default 60s) so a stale ring with a far-future
 * expires_at can't sit on the receiver's screen forever after a WS
 * reconnect mid-ring. AutoDecline reaches us via the overlay's `onDecline`,
 * which is indistinguishable from a user-driven decline on the wire — the
 * server treats both as the ring being over.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { IncomingCallOverlay } from '@bigbluebam/ui/incoming-call-overlay';
import type { BureauWsClient } from './ws-client.js';
import type { RingIncomingEvent } from './types.js';

// ─────────────────────────────────────────────────────────────────────────

export interface RingHandlerProps {
  client: BureauWsClient;
  /**
   * Host-app navigation callback. Receives a path-only URL; hosts typically
   * thread this straight into router.push. The destination SPA's bureau-client
   * SDK is responsible for joining the LiveKit room once it mounts.
   */
  navigate: (url: string) => void;
  /**
   * Safety net: hard cap on the auto-decline timer regardless of what the
   * server's `expires_at` says. Defaults to 60s — a stale ring with a
   * far-future `expires_at` shouldn't sit on the receiver's screen forever
   * if the WS reconnects mid-ring.
   */
  maxAutoDeclineMs?: number;
  /** Optional ringtone URL passed through to the overlay. */
  ringtoneUrl?: string;
  /** Optional hook for hosts that want to surface a toast on accept failure. */
  onAcceptError?: (err: Error, ring: RingIncomingEvent) => void;
}

interface QueuedRing extends RingIncomingEvent {
  /** Local id — falls back to ring_token. */
  localId: string;
  /** Wall-clock when received; used to anchor the auto-decline timer. */
  receivedAt: number;
}

const DEFAULT_MAX_AUTO_DECLINE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────

function stripOrigin(url: string): string {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://x/');
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

/**
 * Best-effort canonical URL for a surface entity. The presence-and-immediate-
 * interaction.md plan calls for per-app URL builders, but until those land
 * we synthesize one from `surface_app` + `surface_id` using the documented
 * nginx routing in CLAUDE.md. Hosts that need a richer URL can intercept
 * `navigate` and rewrite.
 */
function surfaceUrlFor(app: string, id: string): string {
  switch (app) {
    case 'b3':
    case 'bam':
      return `/b3/tasks/${id}`;
    case 'brief':
      // Brief routes documents at /documents/:id (see apps/brief/src/main.tsx).
      return `/brief/documents/${id}`;
    case 'board':
      // Board routes canvases at the root: /board/:id (apps/board/src/main.tsx).
      return `/board/${id}`;
    case 'blueprint':
      return `/blueprint/d/${id}`;
    case 'bond':
      return `/bond/deals/${id}`;
    case 'beacon':
      // Beacon's detail route is /:idOrSlug at the app root (apps/beacon/src/app.tsx).
      return `/beacon/${id}`;
    case 'helpdesk':
      return `/helpdesk/tickets/${id}`;
    case 'book':
      // Book event-detail page (D-4); the docked box joins huddle-book-{id}.
      return `/book/events/${id}`;
    case 'banter':
      // surface_id is the channel id; Banter routes channels by slug, so we
      // go through its /go/:channelId resolver, which bounces to
      // /channels/:slug or /dm/:id once the channel record loads (D-14).
      return `/banter/go/${id}`;
    default:
      // Unknown app: send to the app root with the id as a query param so the
      // host can resolve it itself. This is intentionally lossy; a real
      // production deployment should add a case above.
      return `/${app}/?id=${encodeURIComponent(id)}`;
  }
}

function clampExpiresMs(
  expiresAt: string | undefined,
  receivedAt: number,
  maxMs: number,
): number {
  if (!expiresAt) return maxMs;
  const expiresEpoch = Date.parse(expiresAt);
  if (!Number.isFinite(expiresEpoch)) return maxMs;
  // Anchor on receivedAt rather than Date.now() so the timer is monotonic
  // across re-renders (we capture receivedAt once when the ring lands).
  const remaining = expiresEpoch - receivedAt;
  if (remaining <= 0) return 0;
  return Math.min(remaining, maxMs);
}

// ─────────────────────────────────────────────────────────────────────────

export function RingHandler({
  client,
  navigate,
  maxAutoDeclineMs = DEFAULT_MAX_AUTO_DECLINE_MS,
  ringtoneUrl,
  onAcceptError,
}: RingHandlerProps): React.ReactElement | null {
  const [queue, setQueue] = useState<QueuedRing[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  // Subscribe to ring_incoming.
  useEffect(() => {
    const off = client.on('ring_incoming', (msg) => {
      // De-duplicate by ring_token — the server may fan out the same ring
      // twice on reconnect, and we don't want two overlays on screen.
      setQueue((q) => {
        if (q.some((r) => r.ring_token === msg.ring_token)) return q;
        const next: QueuedRing = {
          ...msg,
          localId: msg.ring_token || `r_${Date.now()}_${Math.random()}`,
          receivedAt: Date.now(),
        };
        return [...q, next];
      });
    });
    return off;
  }, [client]);

  function removeFromQueue(localId: string): void {
    setQueue((q) => q.filter((r) => r.localId !== localId));
  }

  function sendDecline(ring: QueuedRing): void {
    try {
      client.send({
        type: 'ring_respond',
        ring_token: ring.ring_token,
        decision: 'decline',
      });
    } catch {
      // ignore — disconnects swallow this; the server's TTL on the ring
      // record will GC it on its own.
    }
  }

  function accept(ring: QueuedRing): void {
    // Tell the WS hub we accepted so the caller's outgoing-ring toast closes.
    // In the unified-call model (Phase 3) we DO NOT POST surface-huddle/token
    // here — the SDK's ActiveCallManager joins the canonical LiveKit room
    // `huddle-{surface_app}-{surface_id}` automatically when the destination
    // describeLocation() reports a matching surface_id. Navigation alone is
    // sufficient; the token mint happens inside the manager on URL change.
    try {
      client.send({
        type: 'ring_respond',
        ring_token: ring.ring_token,
        decision: 'accept',
      });
    } catch {
      // ignore — best-effort signaling; the server's TTL on the ring record
      // will GC it if we never report back.
    }

    // Plain surface URL — no ?huddle=1 query param. The destination SPA no
    // longer mounts its own huddle UI; the docked box is the single LiveKit
    // endpoint and it joins on its own once describeLocation() updates.
    // Prefer the concrete URL carried on the ring (always present for
    // URL-derived surfaces, whose hashed ids can't be reversed into a
    // path); fall back to the per-app synthesizer for legacy senders.
    const target = stripOrigin(
      ring.surface_url ?? surfaceUrlFor(ring.surface_app, ring.surface_id),
    );
    try {
      navigate(target);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      onAcceptError?.(wrapped, ring);
    }

    // Accepting an invite to the page you're ALREADY on is a same-URL
    // navigate — no route change fires, so a call manager stuck in
    // 'error' (e.g. a mint that 403'd during a presence-session gap)
    // would stay stuck. setTarget() with the unchanged target retries
    // precisely in that case (its no-op guard passes error states
    // through). Delay slightly so a real navigation's location update
    // wins the race when the page DID change.
    window.setTimeout(() => {
      import('./active-room.js')
        .then(({ getActiveCallManager }) => {
          const mgr = getActiveCallManager();
          if (mgr && mgr.getStatus() === 'error') {
            void mgr.setTarget(mgr.getTarget());
          }
        })
        .catch(() => {
          /* best-effort nudge */
        });
    }, 750);
  }

  // Only render the topmost ring at a time — surface huddles are 1-on-1ish
  // and stacking IncomingCallOverlays creates an unreadable z-index war.
  // Subsequent rings stay queued and pop into view as earlier ones resolve.
  const active = useMemo(() => (queue.length > 0 ? queue[0] : null), [queue]);
  if (!active) return null;

  const autoDeclineMs = clampExpiresMs(
    active.expires_at,
    active.receivedAt,
    maxAutoDeclineMs,
  );

  // The overlay calls onAccept→onDismiss or onDecline→onDismiss. We use
  // onDismiss to drop the ring from the queue exactly once, which lets the
  // next queued ring (if any) take the active slot on the following render.
  return (
    <IncomingCallOverlay
      key={active.localId}
      fromUserName={active.from_user_name}
      surfaceApp={active.surface_app}
      surfaceLabel={active.surface_label ?? active.surface_app}
      onAccept={() => {
        accept(active);
      }}
      onDecline={() => sendDecline(active)}
      onDismiss={() => removeFromQueue(active.localId)}
      autoDeclineMs={autoDeclineMs}
      ringtoneUrl={ringtoneUrl}
    />
  );
}
