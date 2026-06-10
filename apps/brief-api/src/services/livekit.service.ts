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

export function isValidBureauRoomName(name: string): boolean {
  return ROOM_NAME_RE.test(name);
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
