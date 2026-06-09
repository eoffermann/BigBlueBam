import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AudioTokenResponse {
  data: {
    token: string;
    room_name: string;
    ws_url: string;
  };
}

// Bureau §9 Strategy B (continuous-audio teleport). When the user is
// summoned to a board with continuous audio enabled, the URL carries
// ?lkRoom=bureau-room-<uuid>. We strictly validate the shape before
// passing it to the API — Board mints a token scoped to the LiveKit
// room name in the JWT, so an unvalidated string would let a caller
// coerce Board into minting a token for an arbitrary LiveKit room.
// Backend re-validates with the same regex; this is defense in depth.
const LK_ROOM_RE = /^bureau-room-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLkRoomFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('lkRoom');
  return raw && LK_ROOM_RE.test(raw) ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Fetch a LiveKit access token for the board's audio room.
 * Tokens are short-lived (1 hour) so we refresh every 10 minutes.
 *
 * @param boardId The board to join. Required.
 * @param lkRoomOverride Optional explicit LiveKit room name. Pass the
 *                       value of `?lkRoom=` from the URL when honoring
 *                       a Bureau continuous-audio summon. Falls back
 *                       to the canonical `board-{boardId}` server-side
 *                       when omitted or rejected by the API's validator.
 */
export function useBoardAudioToken(
  boardId: string | undefined,
  lkRoomOverride?: string,
) {
  return useQuery({
    queryKey: ['board-audio-token', boardId, lkRoomOverride ?? null],
    queryFn: () =>
      api.post<AudioTokenResponse>(`/boards/${boardId}/audio/token`, {
        lk_room: lkRoomOverride,
      }),
    staleTime: 10 * 60 * 1000, // 10 min
    refetchInterval: 10 * 60 * 1000, // auto-refresh before expiry
    enabled: !!boardId,
  });
}
