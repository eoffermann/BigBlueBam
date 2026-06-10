import { mintRoomToken } from '@bigbluebam/livekit-tokens';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// LiveKit token generation for Brief Bureau §9 Strategy B
// ---------------------------------------------------------------------------
//
// Brief does NOT host its own calls. The only reason this service exists is
// Bureau §9 Strategy B (continuous-audio teleport): when a user is summoned
// from a Bureau room into a Brief doc with continuous audio enabled, the
// summon target URL carries `?lkRoom=bureau-room-<uuid>`. The frontend reads
// it, validates the format, and posts it here so Brief mints a LiveKit token
// scoped to the *Bureau* room, which keeps the in-flight call alive across
// the cross-app navigation.
//
// Because Brief has no canonical room of its own to fall back to, an
// invalid or missing `lk_room` is a hard error — there is no fallback room
// shape that makes sense for a Brief doc.

const ROOM_NAME_RE = /^bureau-room-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUREAU_ROOM_PREFIX = 'bureau-room-';

export function isValidBureauRoomName(name: string): boolean {
  return ROOM_NAME_RE.test(name);
}

/**
 * Sentinel error thrown when bureau-api denies the caller's join request
 * for the supplied lk_room. The route handler maps this to a 403 so the
 * frontend can surface a meaningful message rather than a generic 500.
 */
export class BureauRoomAccessDeniedError extends Error {
  constructor(message = 'Bureau room access denied') {
    super(message);
    this.name = 'BureauRoomAccessDeniedError';
  }
}

/**
 * Ask bureau-api whether `userId` is allowed to join `bureauRoomId`.
 *
 * Brief has no canonical call surface, so a denial here is a HARD failure
 * (unlike Board, which can fall back to its own room). We throw
 * BureauRoomAccessDeniedError; the route translates that to a 403.
 *
 * Fail-closed: any condition that prevents an affirmative `allowed: true`
 * (missing secret, network error, non-2xx response, malformed body) is
 * treated as a denial. We never mint a token for a bureau room without
 * positive confirmation from bureau-api.
 */
async function canJoinBureauRoom(
  bureauRoomId: string,
  userId: string,
): Promise<boolean> {
  if (!env.INTERNAL_SERVICE_SECRET) return false;
  const base = env.BUREAU_API_INTERNAL_URL.replace(/\/$/, '');
  const url = `${base}/v1/internal/can-join-room/${encodeURIComponent(
    bureauRoomId,
  )}/${encodeURIComponent(userId)}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-Service-Secret': env.INTERNAL_SERVICE_SECRET,
      },
    });
    if (!response.ok) return false;
    const raw = (await response.json()) as {
      data?: { allowed?: unknown; reason?: unknown };
    };
    return raw?.data?.allowed === true;
  } catch {
    return false;
  }
}

export async function generateBriefAudioToken(
  documentId: string,
  userId: string,
  userName: string,
  roomName: string,
): Promise<{ token: string; roomName: string; wsUrl: string }> {
  if (!isValidBureauRoomName(roomName)) {
    throw new Error('Invalid lk_room — only Bureau room names are accepted');
  }
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit API key and secret are not configured');
  }

  // Bureau ACL check. roomName is `bureau-room-<uuid>`; the bureau-api
  // endpoint takes the UUID directly.
  const bureauRoomId = roomName.slice(BUREAU_ROOM_PREFIX.length);
  const allowed = await canJoinBureauRoom(bureauRoomId, userId);
  if (!allowed) {
    throw new BureauRoomAccessDeniedError(
      'You are not authorized to join this Bureau room',
    );
  }

  const token = await mintRoomToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: userId,
    name: userName,
    roomName,
    ttlSeconds: 3600, // 1 hour
    metadata: {
      source: 'brief',
      document_id: documentId,
    },
    permissions: {
      can_publish: true,
      can_subscribe: true,
      can_publish_data: true,
      can_update_own_metadata: true,
    },
  });

  return {
    token,
    roomName,
    wsUrl: env.LIVEKIT_URL,
  };
}
