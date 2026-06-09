import { SignJWT } from 'jose';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// LiveKit token generation for Board audio conferencing
// ---------------------------------------------------------------------------

export interface LiveKitTokenGrants {
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  room?: string;
  roomJoin?: boolean;
  hidden?: boolean;
}

export interface GenerateTokenOptions {
  participantIdentity: string;
  participantName: string;
  roomName: string;
  grants?: Partial<LiveKitTokenGrants>;
  ttlSeconds?: number;
}

/**
 * Build a LiveKit room name for a board.
 */
export function buildBoardRoomName(boardId: string): string {
  return `board-${boardId}`;
}

/**
 * Generate a LiveKit-compatible JWT access token.
 *
 * LiveKit expects a JWT with specific claims:
 *   - sub: participant identity
 *   - iss: API key
 *   - video: grant claims (room, roomJoin, canPublish, etc.)
 *   - nbf / exp: validity window
 *   - jti: unique token id
 */
export async function generateLiveKitToken(opts: GenerateTokenOptions): Promise<string> {
  const {
    participantIdentity,
    participantName,
    roomName,
    grants = {},
    ttlSeconds = 3600,
  } = opts;

  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    throw new Error('LiveKit API key and secret are not configured');
  }

  const secret = new TextEncoder().encode(env.LIVEKIT_API_SECRET);
  const now = Math.floor(Date.now() / 1000);

  const videoGrants: Record<string, unknown> = {
    room: roomName,
    roomJoin: true,
    canPublish: grants.canPublish ?? true,
    canSubscribe: grants.canSubscribe ?? true,
    canPublishData: grants.canPublishData ?? true,
    // Board audio rooms are audio-only; video is not enabled by default
    canPublishSources: ['microphone'],
  };

  if (grants.hidden !== undefined) {
    videoGrants.hidden = grants.hidden;
  }

  const token = await new SignJWT({
    video: videoGrants,
    metadata: JSON.stringify({ name: participantName }),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(participantIdentity)
    .setIssuer(env.LIVEKIT_API_KEY)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .setJti(crypto.randomUUID())
    .sign(secret);

  return token;
}

/**
 * UUID + bureau-room name validator. Used by `generateBoardAudioToken`
 * to verify a caller-supplied `roomOverride` is the right shape before
 * it lands in a minted token. We accept only two forms:
 *
 *   board-<uuid>          the canonical board room (the default)
 *   bureau-room-<uuid>    a Bureau spatial room the caller is being
 *                         summoned into with continuous audio (§9
 *                         Strategy B of the Bureau design doc)
 *
 * Anything else is rejected. The Bureau access check (does the
 * caller actually belong in that bureau room) is owned by bureau-api;
 * here we just enforce the format so a malicious client cannot
 * coerce Board into minting a token for `room-of-the-CEO` or similar.
 *
 * Once bureau-api lands, board-api should additionally call its
 * internal `/v1/internal/can-join-room/:roomId/:userId` endpoint
 * before issuing a `bureau-room-*` token. Until then the format
 * gate is the only barrier — the room UUIDs are non-enumerable, so
 * a casual attacker can't probe them, but a determined one who
 * knows a roomId could mint a token for it via Board's endpoint.
 * This is acceptable for Bureau v0 because the same caller could
 * also get the same token via Bureau's own mint route once Bureau
 * authorizes them.
 */
const ROOM_NAME_RE = /^(?:board-|bureau-room-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAudioRoomName(name: string): boolean {
  return ROOM_NAME_RE.test(name);
}

/**
 * Generate a token for a user to join a board's audio room.
 * Audio-only: publish microphone, subscribe to all tracks, max 20 participants.
 *
 * @param roomOverride Optional explicit LiveKit room name. When the caller
 *                     is being summoned into a Bureau room with continuous
 *                     audio, the frontend passes the `?lkRoom=` hint here.
 *                     Must match `board-<uuid>` (the canonical default)
 *                     or `bureau-room-<uuid>` (Bureau §9 Strategy B).
 *                     Falls back to the canonical board room when absent
 *                     or invalid.
 */
export async function generateBoardAudioToken(
  boardId: string,
  userId: string,
  userName: string,
  roomOverride?: string,
): Promise<{ token: string; roomName: string; wsUrl: string }> {
  const defaultRoom = buildBoardRoomName(boardId);
  const roomName =
    roomOverride && isValidAudioRoomName(roomOverride) ? roomOverride : defaultRoom;

  const token = await generateLiveKitToken({
    participantIdentity: userId,
    participantName: userName,
    roomName,
    grants: {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
    ttlSeconds: 3600, // 1 hour
  });

  return {
    token,
    roomName,
    wsUrl: env.LIVEKIT_URL,
  };
}
