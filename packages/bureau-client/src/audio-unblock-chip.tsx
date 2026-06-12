/**
 * AudioUnblockChip — one-click recovery from the browser's autoplay
 * policy.
 *
 * Browsers refuse to start audio playback until the user has interacted
 * with the page. A participant who lands directly in a room (e.g. they
 * reloaded mid-call, or auto-joined via a summon) can therefore SEE the
 * other side's video while their audio is silently blocked — LiveKit
 * reports this via Room.canPlaybackAudio, and the ActiveCallManager
 * mirrors it onto snapshot.audioPlaybackBlocked.
 *
 * The chip floats bottom-right (same family as the video-tiles restore
 * chip), shows only while connected-and-blocked, and clears itself the
 * moment Room.startAudio() succeeds inside the click gesture.
 */
import { type CSSProperties } from 'react';
import { useActiveCall } from './use-active-call.js';

const chipStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 240,
  zIndex: 999998,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 12px',
  borderRadius: 999,
  border: '1px solid rgba(250, 204, 21, 0.5)',
  background: 'rgba(15, 23, 42, 0.95)',
  color: '#fde047',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
};

export function AudioUnblockChip(): React.ReactElement | null {
  const call = useActiveCall();
  if (call.status !== 'connected' || !call.audioPlaybackBlocked) return null;
  return (
    <button
      type="button"
      onClick={call.startAudio}
      style={chipStyle}
      title="Your browser blocked call audio until you interact with the page. Click to hear the room."
      aria-label="Enable call audio"
      data-bureau-audio-unblock
    >
      <span aria-hidden="true">🔊</span>
      Tap to enable audio
    </button>
  );
}
