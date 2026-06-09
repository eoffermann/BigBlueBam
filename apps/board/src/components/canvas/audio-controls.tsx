import { useState, useCallback } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useParticipants,
  useTracks,
  useLocalParticipant,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Mic, MicOff, Headphones, PhoneOff, Volume2, Loader2 } from 'lucide-react';
import { useBoardAudioToken, readLkRoomFromUrl } from '@/hooks/use-audio';
// @livekit/components-styles omitted — using custom TailwindCSS styling instead

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AudioControlsProps {
  boardId: string;
}

// ---------------------------------------------------------------------------
// Inner toolbar content (renders inside LiveKitRoom context)
// ---------------------------------------------------------------------------

function AudioToolbarContent({ onDisconnect }: { onDisconnect: () => void }) {
  const participants = useParticipants();
  const tracks = useTracks([Track.Source.Microphone]);
  const { localParticipant } = useLocalParticipant();
  const [isMuted, setIsMuted] = useState(true); // Start muted

  const toggleMute = useCallback(async () => {
    if (!localParticipant) return;
    const newMuted = !isMuted;
    await localParticipant.setMicrophoneEnabled(!newMuted);
    setIsMuted(newMuted);
  }, [localParticipant, isMuted]);

  const speakingParticipants = tracks.filter(
    (t) => t.participant.isSpeaking && t.participant.identity !== localParticipant?.identity,
  );

  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 px-2 py-1">
      {/* Mic toggle */}
      <button
        type="button"
        onClick={toggleMute}
        className={`flex items-center justify-center h-7 w-7 rounded-md transition-colors ${
          isMuted
            ? 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 hover:text-zinc-700 dark:hover:text-zinc-200'
            : 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
        }`}
        title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
      </button>

      {/* Participant count */}
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums px-1">
        {participants.length}
      </span>

      {/* Speaking indicators */}
      {speakingParticipants.length > 0 && (
        <div className="flex items-center gap-1 border-l border-zinc-200 dark:border-zinc-600 pl-1.5">
          <Volume2 className="h-3 w-3 text-green-500 dark:text-green-400 animate-pulse" />
          {speakingParticipants.slice(0, 2).map((t) => (
            <span
              key={t.participant.identity}
              className="text-[11px] text-green-600 dark:text-green-400 max-w-[60px] truncate"
            >
              {t.participant.name || t.participant.identity}
            </span>
          ))}
          {speakingParticipants.length > 2 && (
            <span className="text-[11px] text-green-600 dark:text-green-400">
              +{speakingParticipants.length - 2}
            </span>
          )}
        </div>
      )}

      {/* Disconnect button */}
      <button
        type="button"
        onClick={onDisconnect}
        className="flex items-center justify-center h-7 w-7 rounded-md text-red-500 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
        title="Leave audio room"
      >
        <PhoneOff className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AudioControls({ boardId }: AudioControlsProps) {
  // Bureau §9 Strategy B: when the user arrives via a Bureau summon,
  // the URL carries ?lkRoom=bureau-room-<uuid>. We snapshot it once on
  // mount so a subsequent in-app route change doesn't change the room
  // mid-call. Validation lives in readLkRoomFromUrl — anything else
  // (including a missing query) yields undefined and we fall back to
  // the canonical board-{boardId} room server-side.
  const [lkRoomOverride] = useState<string | undefined>(() => readLkRoomFromUrl());
  const { data: tokenData, isLoading: tokenLoading } = useBoardAudioToken(boardId, lkRoomOverride);
  const [isConnected, setIsConnected] = useState(false);

  const token = tokenData?.data?.token ?? null;
  const wsUrl = tokenData?.data?.ws_url ?? '';

  const handleJoin = useCallback(() => {
    setIsConnected(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setIsConnected(false);
  }, []);

  // Loading token
  if (tokenLoading) {
    return (
      <div className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-400 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }

  // Not connected — show join button
  if (!isConnected || !token) {
    return (
      <button
        type="button"
        onClick={handleJoin}
        disabled={!token}
        className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white/90 dark:bg-zinc-800/90 backdrop-blur shadow-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium"
        title="Join audio room"
      >
        <Headphones className="h-4 w-4" />
        <span>Join Audio</span>
      </button>
    );
  }

  return (
    <LiveKitRoom
      token={token}
      serverUrl={wsUrl}
      audio={false}
      video={false}
      connect={true}
      onDisconnected={handleDisconnect}
    >
      <RoomAudioRenderer />
      <AudioToolbarContent onDisconnect={handleDisconnect} />
    </LiveKitRoom>
  );
}
