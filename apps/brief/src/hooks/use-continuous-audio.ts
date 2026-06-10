import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Bureau §9 Strategy B — continuous-audio teleport (Brief side)
// ---------------------------------------------------------------------------
//
// Brief has no native call surface yet (P-6 stub). The only reason this
// hook exists is to keep an existing LiveKit call alive when a participant
// is summoned into a Brief doc via `?lkRoom=bureau-room-<uuid>` so the
// audio doesn't drop during the cross-app navigation. The regex below is
// the same shape Board enforces (apps/board/src/hooks/use-audio.ts) — kept
// in sync deliberately. Backend re-validates with the same pattern; this
// is defense in depth.

interface AudioTokenResponse {
  data: {
    token: string;
    room_name: string;
    ws_url: string;
  };
}

const LK_ROOM_RE = /^bureau-room-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLkRoomFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('lkRoom');
  return raw && LK_ROOM_RE.test(raw) ? raw : undefined;
}

/**
 * Fetch a LiveKit access token for a Bureau continuous-audio summon landing
 * on a Brief doc. Returns nothing until both `documentId` AND a valid
 * `?lkRoom=` are present. Tokens are short-lived (1 hour) so we refresh
 * every 10 minutes to avoid mid-call expiry.
 */
export function useBriefContinuousAudioToken(
  documentId: string | undefined,
  lkRoom: string | undefined,
) {
  return useQuery({
    queryKey: ['brief-continuous-audio-token', documentId, lkRoom ?? null],
    queryFn: () =>
      api.post<AudioTokenResponse>(`/documents/${documentId}/audio/token`, {
        lk_room: lkRoom,
      }),
    staleTime: 10 * 60 * 1000, // 10 min
    refetchInterval: 10 * 60 * 1000, // auto-refresh before expiry
    enabled: !!documentId && !!lkRoom,
  });
}
