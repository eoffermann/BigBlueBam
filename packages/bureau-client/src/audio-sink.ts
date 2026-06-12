/**
 * BureauAudioSink — remote-audio playback for the unified call manager.
 *
 * LiveKit does NOT auto-play subscribed audio: a remote audio track is
 * silent until someone calls `track.attach()` and the resulting
 * <audio> element joins the DOM. Video worked from day one because the
 * video-tiles window attaches video tracks; audio had no equivalent —
 * the original "remote audio is handled by LiveKit's audio output
 * sink" comment was simply wrong, and the symptom was exactly "I see
 * their video but hear nothing."
 *
 * The sink owns a hidden container div appended to document.body and
 * reconciles it against the room's remote audio publications on every
 * track event: attach what's newly subscribed, detach what's gone.
 * Local audio is never attached (you'd hear your own mic as echo).
 *
 * Autoplay policy is the one thing attach() can't force: browsers may
 * refuse playback until the user has interacted with the page. The
 * ActiveCallManager watches LiveKit's AudioPlaybackStatusChanged for
 * that case and surfaces a one-click "enable audio" chip
 * (audio-unblock-chip.tsx) that calls Room.startAudio().
 */

import { Track, type Room } from 'livekit-client';

/** Which subscribed sources should be audible. Pure; unit-tested. */
export function isPlayableAudioSource(
  source: Track.Source | string | undefined,
  kind: Track.Kind | string | undefined,
  isLocal: boolean,
): boolean {
  if (isLocal) return false; // never play your own mic back at you
  if (source === Track.Source.Microphone) return true;
  if (source === Track.Source.ScreenShareAudio) return true;
  // Defensive: an audio-kind track with an unknown source (SIP/ingest
  // participants, future LiveKit sources) should still be audible.
  return kind === Track.Kind.Audio && source !== Track.Source.ScreenShare && source !== Track.Source.Camera;
}

interface SinkEntry {
  element: HTMLMediaElement;
  detach: () => void;
}

export class BureauAudioSink {
  private container: HTMLElement | null = null;
  private entries = new Map<string, SinkEntry>();

  private ensureContainer(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (this.container && this.container.isConnected) return this.container;
    const el = document.createElement('div');
    el.setAttribute('data-bureau-audio-sink', '');
    // Hidden but NOT display:none — some browsers deprioritize or pause
    // media inside display:none subtrees. Visually-absent is enough.
    el.style.position = 'fixed';
    el.style.width = '0';
    el.style.height = '0';
    el.style.overflow = 'hidden';
    document.body.appendChild(el);
    this.container = el;
    return el;
  }

  /**
   * Reconcile the sink against the room's current remote audio
   * publications. Idempotent — safe to call on every track event.
   */
  sync(room: Room): void {
    const container = this.ensureContainer();
    if (!container) return;

    // Collect every playable, currently-subscribed remote audio track.
    const want = new Map<string, { attach: () => HTMLMediaElement; detach: (el: HTMLMediaElement) => void }>();
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        const track = pub.track;
        const sid = pub.trackSid;
        if (!track || !sid) return; // published but not subscribed yet
        if (!isPlayableAudioSource(pub.source, pub.kind, false)) return;
        want.set(sid, track as unknown as { attach: () => HTMLMediaElement; detach: (el: HTMLMediaElement) => void });
      });
    });

    // Detach anything that disappeared (unsubscribed / participant left).
    for (const [sid, entry] of this.entries) {
      if (!want.has(sid)) {
        try {
          entry.detach();
        } catch {
          /* track may already be disposed */
        }
        entry.element.remove();
        this.entries.delete(sid);
      }
    }

    // Attach anything new.
    for (const [sid, track] of want) {
      if (this.entries.has(sid)) continue;
      try {
        const element = track.attach();
        element.setAttribute('data-bureau-audio', sid);
        container.appendChild(element);
        this.entries.set(sid, {
          element,
          detach: () => track.detach(element),
        });
      } catch {
        // attach() can throw mid-teardown; the next sync retries.
      }
    }
  }

  /** Tear everything down (room disconnect / manager dispose). */
  detachAll(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.detach();
      } catch {
        /* already gone */
      }
      entry.element.remove();
    }
    this.entries.clear();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }

  /** Number of currently-attached audio elements (tests + debugging). */
  get size(): number {
    return this.entries.size;
  }
}
