import { useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useParticipants,
} from '@livekit/components-react';
import { Headphones } from 'lucide-react';
import {
  readLkRoomFromUrl,
  useBriefContinuousAudioToken,
} from '@/hooks/use-continuous-audio';

// ---------------------------------------------------------------------------
// Bureau §9 Strategy B — Brief continuous-audio bubble
// ---------------------------------------------------------------------------
//
// This is the P-6 *stub*. Brief intentionally does NOT host calls; the only
// reason this widget exists is so a Bureau summon to a Brief doc with
// continuous audio enabled keeps the call alive while the user reads. No
// participant tile, no mute UI, no call panel — just a hidden audio
// renderer plus a small "On call · N people" bubble so the user can see
// the call is still connected.
//
// Mounts only when ?lkRoom=bureau-room-<uuid> is present and validates.
// Anything else renders nothing.

interface ContinuousAudioWidgetProps {
  documentId: string | undefined;
}

function CallStatusBubble() {
  const participants = useParticipants();
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full bg-zinc-900/80 px-3 py-1.5 text-xs text-zinc-100 shadow-lg backdrop-blur dark:bg-zinc-100/90 dark:text-zinc-900"
      title="Continuous audio from Bureau"
    >
      <Headphones className="h-3 w-3" />
      <span>
        On call &middot; {participants.length}{' '}
        {participants.length === 1 ? 'person' : 'people'}
      </span>
    </div>
  );
}

export function ContinuousAudioWidget({ documentId }: ContinuousAudioWidgetProps) {
  // Snapshot ?lkRoom once on mount. Subsequent in-app route changes (e.g.
  // saving the doc, which may push a new slug) must not change the room
  // mid-call. readLkRoomFromUrl returns undefined unless the value matches
  // the bureau-room-<uuid> shape.
  const [lkRoom] = useState<string | undefined>(() => readLkRoomFromUrl());
  const { data: tokenData } = useBriefContinuousAudioToken(documentId, lkRoom);

  // No Bureau summon → render nothing. This is the common case.
  if (!lkRoom) return null;

  const token = tokenData?.data?.token ?? null;
  const wsUrl = tokenData?.data?.ws_url ?? '';

  // Still loading or token failed → render nothing rather than a half-state
  // widget. The Bureau-side call panel is the source of truth for the call;
  // we just keep the audio pipe open if we can.
  if (!token || !wsUrl) return null;

  return (
    <LiveKitRoom
      token={token}
      serverUrl={wsUrl}
      audio={true}
      video={false}
      connect={true}
    >
      <RoomAudioRenderer />
      <CallStatusBubble />
    </LiveKitRoom>
  );
}
