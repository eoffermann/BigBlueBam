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
 *   2. On Accept: POSTs /bureau/api/v1/surface-huddle/token to mint a
 *      LiveKit token for `huddle-{surface_app}-{surface_id}`, then calls
 *      the host adapter's `navigate(...)` callback with the surface URL +
 *      `?huddle=1` so the destination SPA knows to mount its huddle UI.
 *   3. On Decline / AutoDecline: posts `ring_respond` back through the WS
 *      so the caller's UI can close the outgoing-ring toast.
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
   * Host-app navigation callback. Receives a path-only URL with `?huddle=1`
   * already appended; hosts typically thread this straight into router.push.
   */
  navigate: (url: string) => void;
  /**
   * Surface-huddle token endpoint. Defaults to the canonical nginx-proxied
   * path. Override for testing or for hosts that proxy bureau through a
   * non-default base.
   */
  tokenEndpoint?: string;
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

interface SurfaceHuddleTokenResponse {
  /** LiveKit room name the caller already minted, e.g. `huddle-brief-abc123`. */
  room: string;
  /** LiveKit access token. */
  token: string;
  /** LiveKit SFU URL. */
  url: string;
}

const DEFAULT_MAX_AUTO_DECLINE_MS = 60_000;

const DEFAULT_TOKEN_ENDPOINT = '/bureau/api/v1/surface-huddle/token';

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
 * Append `huddle=1` to a path-style URL, preserving any existing query.
 * Used to signal to the destination SPA that it should mount its huddle UI
 * on mount instead of waiting for a user click.
 */
function withHuddleParam(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}huddle=1`;
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
      return `/brief/d/${id}`;
    case 'board':
      return `/board/b/${id}`;
    case 'blueprint':
      return `/blueprint/d/${id}`;
    case 'bond':
      return `/bond/deals/${id}`;
    case 'beacon':
      return `/beacon/a/${id}`;
    case 'helpdesk':
      return `/helpdesk/tickets/${id}`;
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
  tokenEndpoint = DEFAULT_TOKEN_ENDPOINT,
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

  async function accept(ring: QueuedRing): Promise<void> {
    // Tell the WS hub we accepted so the caller's outgoing-ring toast closes.
    // We send this before the token POST so the caller's UI updates promptly
    // even if the token endpoint is slow / down.
    try {
      client.send({
        type: 'ring_respond',
        ring_token: ring.ring_token,
        decision: 'accept',
      });
    } catch {
      // ignore — the surface-huddle/token endpoint also validates the ring
      // token server-side, so the accept event is best-effort signaling.
    }

    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ring_token: ring.ring_token,
          surface_app: ring.surface_app,
          surface_id: ring.surface_id,
        }),
      });
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      onAcceptError?.(wrapped, ring);
      return;
    }

    if (!response.ok) {
      const wrapped = new Error(
        `surface-huddle/token returned ${response.status}`,
      );
      onAcceptError?.(wrapped, ring);
      return;
    }

    // Parse the token payload but don't store it here — the destination SPA
    // will fetch its own fresh token (the surface huddle UI on the other
    // side reads from /bureau/api/v1/surface-huddle/token too). We just need
    // to know the POST succeeded before navigating.
    try {
      (await response.json()) as SurfaceHuddleTokenResponse;
    } catch {
      // The endpoint returned 2xx with a non-JSON body — proceed anyway;
      // navigating to the surface is still the right move.
    }

    const target = withHuddleParam(stripOrigin(surfaceUrlFor(ring.surface_app, ring.surface_id)));
    try {
      navigate(target);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      onAcceptError?.(wrapped, ring);
    }
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
        void accept(active);
      }}
      onDecline={() => sendDecline(active)}
      onDismiss={() => removeFromQueue(active.localId)}
      autoDeclineMs={autoDeclineMs}
      ringtoneUrl={ringtoneUrl}
    />
  );
}
