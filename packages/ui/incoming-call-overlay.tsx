/**
 * Canonical IncomingCallOverlay component shared across every BigBlueBam app
 * that needs a "you are being rung" UI — including the new surface-scoped
 * huddle ring (presence-and-immediate-interaction.md §3) and the legacy
 * Banter voice/video call notice.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/incoming-call-overlay' ->
 *     '<root>/packages/ui/incoming-call-overlay.tsx'
 *
 * Behaviour (generalized from apps/banter/src/components/calls/
 * incoming-call-overlay.tsx, which this replaces over time):
 *   - Fixed top-right overlay (not full-screen blocker). Motion-driven
 *     entry: slides + fades from the top-right corner.
 *   - Auto-declines after `autoDeclineMs` (default 30s) by calling
 *     `onDecline`. The host owns what 'decline' actually does on the wire.
 *   - Plays a looping ring sound via Audio() when `ringtoneUrl` is given,
 *     focused tab or not (a call should ring like a phone). Audio is
 *     best-effort: failures are swallowed (autoplay policies, missing
 *     asset, etc.) and the overlay remains usable.
 *   - Accept / Decline / Dismiss are caller-controlled. `onDismiss` is
 *     called once after either Accept or Decline is hit, so the host can
 *     unmount cleanly.
 *
 * Light- and dark-mode safe. No external deps beyond React + lucide-react.
 */

import { Phone, PhoneOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface IncomingCallOverlayProps {
  fromUserName: string;
  fromUserAvatarUrl?: string;
  /** Discriminator for the calling app ('banter', 'brief', 'board', …). */
  surfaceApp: string;
  /** Human-readable label for the surface being rung from. */
  surfaceLabel: string;
  onAccept: () => void;
  onDecline: () => void;
  /**
   * Called once after Accept or Decline (manual or auto). The host should
   * use this to drop the overlay from its render tree.
   */
  onDismiss: () => void;
  /**
   * Verb phrase rendered before the surface label. Defaults to the
   * huddle/ring wording ("wants to huddle on"); callers with different
   * semantics (e.g. Bureau "Bring") pass their own ("wants to bring you
   * along to") while keeping the identical overlay + ringtone.
   */
  actionLabel?: string;
  /** Defaults to 30000 (30s). */
  autoDeclineMs?: number;
  /**
   * Optional ringtone URL. If omitted, no audio is attempted. Playback is
   * best-effort and subject to the browser's autoplay policy.
   */
  ringtoneUrl?: string;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function generateAvatarInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const firstPart = parts[0];
  if (!firstPart) return '?';
  if (parts.length === 1) {
    return firstPart.substring(0, 2).toUpperCase();
  }
  const first = firstPart[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return (first + last).toUpperCase();
}

export function IncomingCallOverlay({
  fromUserName,
  fromUserAvatarUrl,
  surfaceApp,
  surfaceLabel,
  onAccept,
  onDecline,
  onDismiss,
  actionLabel = 'wants to huddle on',
  autoDeclineMs = 30000,
  ringtoneUrl,
}: IncomingCallOverlayProps) {
  const [entered, setEntered] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dismissedRef = useRef(false);

  // Trigger the motion-in transition on next frame.
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  // Auto-decline timer.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      onDecline();
      onDismiss();
    }, autoDeclineMs);
    return () => window.clearTimeout(timer);
  }, [autoDeclineMs, onDecline, onDismiss]);

  // Ring sound. Played regardless of tab focus — an incoming call should
  // be audible from a background tab, exactly like a phone. The browser's
  // autoplay policy is the real gate (no sound until the user has ever
  // interacted with the page) and the .catch below honors it silently.
  useEffect(() => {
    if (!ringtoneUrl) return;
    if (typeof document === 'undefined') return;
    try {
      const audio = new Audio(ringtoneUrl);
      audio.loop = true;
      audio.volume = 0.4;
      audioRef.current = audio;
      void audio.play().catch(() => {
        // Autoplay blocked. Silent fall-through; visual UI still shows.
      });
    } catch {
      // ignore
    }
    return () => {
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
          a.currentTime = 0;
        } catch {
          // ignore
        }
        audioRef.current = null;
      }
    };
  }, [ringtoneUrl]);

  const stopRing = () => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch {
        // ignore
      }
    }
  };

  const handleAccept = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    stopRing();
    onAccept();
    onDismiss();
  };

  const handleDecline = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    stopRing();
    onDecline();
    onDismiss();
  };

  const initials = generateAvatarInitials(fromUserName);

  return (
    <div
      className={cn(
        'fixed top-4 right-4 z-[70] w-80 max-w-[calc(100vw-2rem)]',
        'transition-all duration-200 ease-out',
        entered ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 scale-95',
      )}
      role="alertdialog"
      aria-labelledby="incoming-call-title"
    >
      <div
        className={cn(
          'rounded-2xl border shadow-2xl overflow-hidden',
          'bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700',
        )}
      >
        <div className="flex items-center gap-4 px-4 py-4">
          {/* Avatar with pulsing rings */}
          <div className="relative flex items-center justify-center shrink-0">
            <span className="absolute h-14 w-14 rounded-full bg-emerald-500/20 animate-ping" />
            <span
              className="absolute h-12 w-12 rounded-full bg-emerald-500/30 animate-ping"
              style={{ animationDelay: '300ms' }}
            />
            <div
              className={cn(
                'relative h-10 w-10 rounded-full flex items-center justify-center',
                'text-white text-sm font-semibold z-10',
                'ring-2 ring-white dark:ring-zinc-900',
                'bg-zinc-500',
              )}
            >
              {fromUserAvatarUrl ? (
                <img
                  src={fromUserAvatarUrl}
                  alt={fromUserName}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
          </div>

          {/* Caller info */}
          <div className="min-w-0 flex-1">
            <p
              id="incoming-call-title"
              className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate"
            >
              {fromUserName}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
              {actionLabel}{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{surfaceLabel}</span>
              <span className="text-zinc-400 dark:text-zinc-500"> · {surfaceApp}</span>
            </p>
          </div>
        </div>

        {/* Accept / Decline */}
        <div className="grid grid-cols-2 gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={handleDecline}
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium',
              'bg-red-600 hover:bg-red-700 text-white transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 active:scale-[0.98]',
            )}
          >
            <PhoneOff className="h-4 w-4" />
            Decline
          </button>
          <button
            type="button"
            onClick={handleAccept}
            className={cn(
              'flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium',
              'bg-emerald-600 hover:bg-emerald-700 text-white transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 active:scale-[0.98]',
              'animate-pulse',
            )}
          >
            <Phone className="h-4 w-4" />
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
